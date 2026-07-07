import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Branch } from '../branches/branch.entity';
import { Profile } from '../users/profile.entity';
import { AuthGuard } from './auth.guard';
import { RolesGuard } from './roles.guard';
import { SupabaseJwtService } from './supabase-jwt.service';

@Module({
  imports: [TypeOrmModule.forFeature([Profile, Branch])],
  providers: [SupabaseJwtService, AuthGuard, RolesGuard],
  exports: [SupabaseJwtService, AuthGuard, RolesGuard, TypeOrmModule],
})
export class AuthModule {}
