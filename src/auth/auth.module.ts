import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Profile } from '../users/profile.entity';
import { AuthGuard } from './auth.guard';
import { RolesGuard } from './roles.guard';
import { SupabaseJwtService } from './supabase-jwt.service';

@Module({
  imports: [TypeOrmModule.forFeature([Profile])],
  providers: [SupabaseJwtService, AuthGuard, RolesGuard],
  exports: [SupabaseJwtService, AuthGuard, RolesGuard, TypeOrmModule],
})
export class AuthModule {}
