import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Branch } from '../branches/branch.entity';
import { AuthRegistrationService } from './auth-registration.service';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { CustomerBootstrapGuard } from './customer-bootstrap.guard';
import { RolesGuard } from './roles.guard';
import { SupabaseJwtService } from './supabase-jwt.service';

@Module({
  // Branch is registered so the guard can validate protected branch UUID claims
  // against live core.branches rows (AGENTS.md §5).
  imports: [TypeOrmModule.forFeature([Branch])],
  controllers: [AuthController],
  providers: [
    AuthRegistrationService,
    SupabaseJwtService,
    AuthGuard,
    CustomerBootstrapGuard,
    RolesGuard,
  ],
  exports: [SupabaseJwtService, AuthGuard, CustomerBootstrapGuard, RolesGuard, TypeOrmModule],
})
export class AuthModule {}
