import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, throwError, timer } from 'rxjs';
import { catchError, switchMap } from 'rxjs/operators';

/**
 * Postgres connection-drop patterns emitted by node-postgres (pg) when
 * Supavisor rotates or drops an idle connection from the pool.
 */
const PG_CONNECTION_ERROR_PATTERNS = [
  'connection terminated',
  'connection timeout',
  'connection refused',
  'econnreset',
  'econnrefused',
  'etimedout',
  'socket hang up',
  'client checkout timed out',
  'acquire client timeout',
];

function isPgConnectionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const message =
    ('message' in error && typeof (error as { message: unknown }).message === 'string'
      ? (error as { message: string }).message
      : '') +
    ('detail' in error && typeof (error as { detail: unknown }).detail === 'string'
      ? (error as { detail: string }).detail
      : '');
  const lower = message.toLowerCase();
  return PG_CONNECTION_ERROR_PATTERNS.some((pattern) => lower.includes(pattern));
}

/**
 * Globally registered interceptor that silently retries handlers when a
 * transient pg-pool connection error is detected. Retries twice (delays:
 * 100 ms then 200 ms) before allowing the error to propagate as a 500.
 *
 * Only connection-drop errors are retried -- query/application errors pass
 * through immediately so they are never masked.
 */
@Injectable()
export class DatabaseRetryInterceptor implements NestInterceptor {
  private readonly maxRetries = 2;
  private readonly retryDelaysMs = [100, 200];

  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return this.withRetry(next.handle(), 0);
  }

  private withRetry(source$: Observable<unknown>, attempt: number): Observable<unknown> {
    return source$.pipe(
      catchError((error: unknown) => {
        if (!isPgConnectionError(error) || attempt >= this.maxRetries) {
          return throwError(() => error);
        }

        const delayMs = this.retryDelaysMs[attempt] ?? 200;
        console.warn(
          `[DatabaseRetryInterceptor] pg connection error on attempt ${attempt + 1}/${this.maxRetries + 1} -- retrying in ${delayMs} ms. Error: ${error instanceof Error ? error.message : String(error)}`,
        );

        return timer(delayMs).pipe(
          switchMap(() => this.withRetry(source$, attempt + 1)),
        );
      }),
    );
  }
}
