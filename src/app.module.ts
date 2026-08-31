import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { resolve4 } from 'node:dns/promises';
import { AuthModule } from './auth/auth.module';
import { BranchesModule } from './branches/branches.module';
import { CimModule } from './cim/cim.module';
import { ExpensesModule } from './expenses/expenses.module';
import { FleetModule } from './fleet/fleet.module';
import { LoyaltyModule } from './loyalty/loyalty.module';
import { CsatModule } from './csat/csat.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PricesModule } from './prices/prices.module';
import { ReferenceModule } from './reference/reference.module';
import { ServiceRequestsModule } from './service-requests/service-requests.module';
import { UsersModule } from './users/users.module';
import { GovernanceModule } from './governance/governance.module';

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
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: async (config: ConfigService) => {
        const databaseUrl = new URL(config.getOrThrow<string>('DATABASE_URL'));

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

        return {
          type: 'postgres' as const,
          url: databaseUrl.toString(),
          ssl: { rejectUnauthorized: false },
          connectTimeoutMS: 5_000,
          poolSize: 5,
          extra: {
            // Fail inside the API's 10-second web-client budget so the BFF can
            // return an explicit unavailable response instead of leaving the
            // dashboard waiting on a saturated pool.
            connectionTimeoutMillis: 5_000,
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
          autoLoadEntities: true,
          // Schema changes go through migrations only (AGENTS.md §6).
          synchronize: false,
        };
      },
    }),
    AuthModule,
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
  ],
})
export class AppModule {}
