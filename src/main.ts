import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // The web dashboard calls us cross-origin with a Bearer token (no cookies).
  const webOrigins = (process.env.WEB_ORIGIN ?? 'http://localhost:3000')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  // localhost and 127.0.0.1 are the same machine but distinct CORS origins, so a
  // dashboard opened at 127.0.0.1:3000 would otherwise be blocked (the browser
  // fetch throws and login shows "Could not reach the server"). Accept any
  // loopback origin in addition to the explicitly configured ones.
  const isLoopbackOrigin = (origin: string): boolean =>
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);

  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      // Non-browser callers (curl, same-origin, server-side) send no Origin.
      if (!origin || webOrigins.includes(origin) || isLoopbackOrigin(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
  });

  app.setGlobalPrefix('api');

  // Strip unknown keys so handlers only ever see validated DTO fields —
  // never trust raw client input for scoping decisions (AGENTS.md §12).
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  await app.listen(Number(process.env.PORT ?? 3001));
}

void bootstrap();
