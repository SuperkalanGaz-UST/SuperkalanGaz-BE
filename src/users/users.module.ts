import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { Branch } from '../branches/branch.entity';
import { GoTrueAdminService } from './gotrue-admin.service';
import { StaffRegistrationController } from './staff-registration.controller';
import { StaffRegistrationService } from './staff-registration.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  // Identity lives entirely in Supabase Auth (no profiles table); the service
  // reaches it through the GoTrue Admin API, so no entity is registered here.
  imports: [AuthModule, TypeOrmModule.forFeature([Branch])],
  controllers: [UsersController, StaffRegistrationController],
  providers: [UsersService, StaffRegistrationService, GoTrueAdminService],
  exports: [GoTrueAdminService],
})
export class UsersModule {}
