import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface TraccarDevice {
  id: number;
  name: string;
  uniqueId: string;
}

class TraccarRequestError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'TraccarRequestError';
  }
}

/** Server-only adapter for the self-hosted Traccar middleware. Authentication
 * values never leave this class and response bodies are not copied into errors
 * or logs because they may contain middleware details. */
@Injectable()
export class TraccarClient {
  constructor(private readonly config: ConfigService) {}

  /** Lookup-before-create makes a retry safe when the first POST succeeded in
   * Traccar but its response was lost to a timeout. */
  async provisionDevice(name: string, uniqueId: string): Promise<TraccarDevice> {
    const retryLimit = this.integerSetting('TRACCAR_RETRY_LIMIT', 1, 0, 3);
    let finalError: TraccarRequestError | null = null;

    for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
      try {
        const existing = await this.findByUniqueId(uniqueId);
        if (existing) return existing;
        return await this.createDevice(name, uniqueId);
      } catch (error) {
        const requestError = this.asRequestError(error);
        finalError = requestError;
        if (!requestError.retryable || attempt === retryLimit) {
          throw requestError;
        }
      }
    }

    throw finalError ?? new TraccarRequestError('Traccar provisioning failed', false);
  }

  private async findByUniqueId(uniqueId: string): Promise<TraccarDevice | null> {
    const result = await this.request<unknown[]>(
      `/api/devices?uniqueId=${encodeURIComponent(uniqueId)}`,
      { method: 'GET' },
    );
    if (!Array.isArray(result)) {
      throw new TraccarRequestError('Traccar returned an invalid device list', false);
    }

    const exactMatches = result
      .map((candidate) => this.parseDevice(candidate))
      .filter(
        (candidate): candidate is TraccarDevice =>
          candidate !== null && candidate.uniqueId === uniqueId,
      );

    if (exactMatches.length > 1) {
      throw new TraccarRequestError(
        'Traccar contains duplicate records for this hardware identifier',
        false,
      );
    }
    return exactMatches[0] ?? null;
  }

  private async createDevice(
    name: string,
    uniqueId: string,
  ): Promise<TraccarDevice> {
    const result = await this.request<unknown>('/api/devices', {
      method: 'POST',
      body: JSON.stringify({ name, uniqueId, attributes: {} }),
    });
    const device = this.parseDevice(result);
    if (!device) {
      throw new TraccarRequestError('Traccar returned an invalid device record', false);
    }
    return device;
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const baseUrl = this.requiredSetting('TRACCAR_BASE_URL').replace(/\/$/, '');
    const token = this.requiredSetting('TRACCAR_TOKEN');
    const timeoutMs = this.integerSetting('TRACCAR_TIMEOUT_MS', 5000, 500, 30000);

    try {
      const response = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        },
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        throw new TraccarRequestError(
          `Traccar request failed with HTTP ${response.status}`,
          response.status === 409 || response.status === 429 || response.status >= 500,
        );
      }
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof TraccarRequestError) throw error;
      throw new TraccarRequestError(
        error instanceof Error && error.name === 'TimeoutError'
          ? 'Traccar request timed out'
          : 'Traccar is unreachable',
        true,
      );
    }
  }

  private parseDevice(value: unknown): TraccarDevice | null {
    if (typeof value !== 'object' || value === null) return null;
    const candidate = value as Record<string, unknown>;
    if (
      typeof candidate.id !== 'number' ||
      typeof candidate.name !== 'string' ||
      typeof candidate.uniqueId !== 'string'
    ) {
      return null;
    }
    return {
      id: candidate.id,
      name: candidate.name,
      uniqueId: candidate.uniqueId,
    };
  }

  private requiredSetting(name: string): string {
    const value = this.config.get<string>(name)?.trim();
    if (!value) {
      throw new TraccarRequestError(`${name} is not configured`, false);
    }
    return value;
  }

  private integerSetting(
    name: string,
    fallback: number,
    minimum: number,
    maximum: number,
  ): number {
    const raw = this.config.get<string>(name);
    if (!raw) return fallback;
    const value = Number(raw);
    return Number.isInteger(value) && value >= minimum && value <= maximum
      ? value
      : fallback;
  }

  private asRequestError(error: unknown): TraccarRequestError {
    return error instanceof TraccarRequestError
      ? error
      : new TraccarRequestError('Traccar provisioning failed', false);
  }
}
