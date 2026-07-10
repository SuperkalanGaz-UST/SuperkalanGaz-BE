import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GoTrueAdminService } from './gotrue-admin.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  // Identity lives entirely in Supabase Auth (no profiles table); the service
  // reaches it through the GoTrue Admin API, so no entity is registered here.
  imports: [AuthModule],
  controllers: [UsersController],
  providers: [UsersService, GoTrueAdminService],
})
export class UsersModule {}
