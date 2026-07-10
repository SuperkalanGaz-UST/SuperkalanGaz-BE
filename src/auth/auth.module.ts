import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Branch } from '../branches/branch.entity';
import { AuthGuard } from './auth.guard';
import { RolesGuard } from './roles.guard';
import { SupabaseJwtService } from './supabase-jwt.service';

@Module({
  // Branch is registered so the guard can resolve a caller's branch NAMES (from
  // the JWT's app_metadata) to their core.branches UUIDs (AGENTS.md §5).
  imports: [TypeOrmModule.forFeature([Branch])],
  providers: [SupabaseJwtService, AuthGuard, RolesGuard],
  exports: [SupabaseJwtService, AuthGuard, RolesGuard, TypeOrmModule],
})
export class AuthModule {}
