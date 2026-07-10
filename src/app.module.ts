import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from './auth/auth.module';
import { BranchesModule } from './branches/branches.module';
import { CimModule } from './cim/cim.module';
import { FleetModule } from './fleet/fleet.module';
import { ReferenceModule } from './reference/reference.module';
import { ServiceRequestsModule } from './service-requests/service-requests.module';
import { UsersModule } from './users/users.module';

/**
 * Modular monolith root (AGENTS.md §4). Supabase is used as managed Postgres ONLY:
 * we connect with a standard Postgres connection string + TypeORM. The Supabase
 * client SDK / PostgREST are deliberately absent — they would bypass the
 * branch-scoped guard system enforced in this application layer.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        url: config.getOrThrow<string>('DATABASE_URL'),
        // Supabase requires TLS; its pooler presents a cert we don't pin here.
        ssl: { rejectUnauthorized: false },
        autoLoadEntities: true,
        // Schema changes go through migrations only (AGENTS.md §6).
        synchronize: false,
      }),
    }),
    AuthModule,
    UsersModule,
    BranchesModule,
    ReferenceModule,
    CimModule,
    FleetModule,
    ServiceRequestsModule,
  ],
})
export class AppModule {}
