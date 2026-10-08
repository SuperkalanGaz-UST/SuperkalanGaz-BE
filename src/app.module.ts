import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { resolve4 } from 'node:dns/promises';
import { readFileSync } from 'node:fs';
import { DatabaseRetryInterceptor } from './common/database-retry.interceptor';
import { AuthModule } from './auth/auth.module';
import { BranchesModule } from './branches/branches.module';
import { CimModule } from './cim/cim.module';
import { ExpensesModule } from './expenses/expenses.module';
import { FleetModule } from './fleet/fleet.module';
import { InventoryModule } from './inventory/inventory.module';
import { LoyaltyModule } from './loyalty/loyalty.module';
import { CsatModule } from './csat/csat.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PricesModule } from './prices/prices.module';
import { ReferenceModule } from './reference/reference.module';
import { ServiceRequestsModule } from './service-requests/service-requests.module';
import { UsersModule } from './users/users.module';
import { GovernanceModule } from './governance/governance.module';
import { HealthModule } from './health/health.module';

/**
 * Modular monolith root (AGENTS.md §4). Supabase PostgreSQL is accessed through
 * a standard connection + TypeORM. The Supabase client SDK / PostgREST are
 * deliberately absent — they would bypass the branch-scoped guard system. A
 * temporary private Storage adapter is separately used by SRD for delivery
 * proof bytes; it is server-only and never a domain-data access path.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // M3 fix: no route had any request-rate limiting. This generous global
    // default (120 req/min/IP) exists to stop runaway loops and brute force,
    // not to throttle normal dashboard polling; individual public auth/
    // invitation routes layer a much tighter limit via @Throttle (see their
    // controllers) since they are the realistic abuse targets.
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 120 }]),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: async (config: ConfigService) => {
        const databaseUrl = new URL(config.getOrThrow<string>('DATABASE_URL'));
        const databaseSsl = config.get<string>('DATABASE_SSL', 'true') !== 'false';
        const databaseSslRejectUnauthorized =
          config.get<string>('DATABASE_SSL_REJECT_UNAUTHORIZED', 'true') !== 'false';
        const databaseSslCaCertPath = config.get<string>('DATABASE_SSL_CA_CERT_PATH');
        const nodeEnvironment = config.get<string>('NODE_ENV', 'development');

        if (
          nodeEnvironment === 'production' &&
          (!databaseSsl || !databaseSslRejectUnauthorized || !databaseSslCaCertPath)
        ) {
          throw new Error(
            'Production Postgres connections require TLS verification and the Supabase CA certificate',
          );
        }

        // node-postgres replaces the explicit ssl object when SSL parameters are
        // present in a connection string. Remove those parameters so the CA and
        // certificate-verification settings below remain authoritative.
        for (const key of [...databaseUrl.searchParams.keys()]) {
          if (['sslmode', 'sslrootcert', 'sslcert', 'sslkey'].includes(key.toLowerCase())) {
            databaseUrl.searchParams.delete(key);
          }
        }
        const databaseSslCaCert = databaseSslCaCertPath
          ? readFileSync(databaseSslCaCertPath, 'utf8')
          : undefined;

        if (config.get<string>('DATABASE_RESOLVE_POOLER_IPV4') === 'true') {
          if (!databaseUrl.hostname.endsWith('.pooler.supabase.com')) {
            throw new Error(
              'DATABASE_RESOLVE_POOLER_IPV4 requires a Supabase pooler DATABASE_URL',
            );
          }
          const addresses = await resolve4(databaseUrl.hostname);
          if (addresses.length === 0) {
            throw new Error('The configured Supabase pooler has no IPv4 address');
          }
          // Some local networks stall the PostgreSQL TLS handshake when SNI is
          // sent to Supavisor. Resolving once at startup keeps TLS enabled while
          // preventing node-postgres from sending SNI for an IP-literal host.
          databaseUrl.hostname = addresses[0];
        }

        // Log the resolved endpoint so future connection failures are easy to
        // diagnose without digging through pg internals. Never log credentials.
        const diagnosticHost = databaseUrl.hostname;
        const diagnosticPort = databaseUrl.port || '5432';
        console.log(
          `[TypeORM] Connecting to Postgres at ${diagnosticHost}:${diagnosticPort}`,
        );

        return {
          type: 'postgres' as const,
          url: databaseUrl.toString(),
          // Production must verify the server certificate. A local-only
          // compatibility override remains available for a network that cannot
          // complete TLS, but the startup guard above prevents that weakening
          // from reaching a production deployment.
          ...(databaseSsl
            ? {
                ssl: {
                  rejectUnauthorized: databaseSslRejectUnauthorized,
                  ...(databaseSslCaCert ? { ca: databaseSslCaCert } : {}),
                },
              }
            : {}),
          connectTimeoutMS: 10_000,
          poolSize: 5,
          extra: {
            // Fail inside the API's 10-second web-client budget so the BFF can
            // return an explicit unavailable response instead of leaving the
            // dashboard waiting on a saturated pool.
            connectionTimeoutMillis: 10_000,
            query_timeout: 8_000,
            statement_timeout: 8_000,
            idle_in_transaction_session_timeout: 8_000,
            idleTimeoutMillis: 15_000,
            keepAlive: true,
            keepAliveInitialDelayMillis: 1_000,
            // Supavisor endpoints can rotate. Recycling connections prevents a
            // long-running API process from keeping a stale pool indefinitely.
            maxLifetimeSeconds: 300,
            maxUses: 100,
            max: 5,
          },
          // Give transient network blips room to resolve before giving up.
          // TypeORM retries on a fixed interval; using a longer delay means
          // each successive attempt waits more — approximating backoff without
          // a custom retry loop. The app only exits after all attempts are
          // genuinely exhausted, not on the first failure.
          retryAttempts: 8,
          retryDelay: 5_000,
          // Log each failed attempt with the host so the operator can see
          // exactly which endpoint was unreachable and how many tries remain.
          verboseRetryLog: true,
          autoLoadEntities: true,
          // Schema changes go through migrations only (AGENTS.md §6).
          synchronize: false,
        };
      },
    }),
    AuthModule,
    HealthModule,
    UsersModule,
    BranchesModule,
    ReferenceModule,
    CimModule,
    ExpensesModule,
    FleetModule,
    ServiceRequestsModule,
    LoyaltyModule,
    CsatModule,
    NotificationsModule,
    PricesModule,
    GovernanceModule,
    InventoryModule,
  ],
  providers: [
    {
      provide: APP_INTERCEPTOR,
      useClass: DatabaseRetryInterceptor,
    },
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
