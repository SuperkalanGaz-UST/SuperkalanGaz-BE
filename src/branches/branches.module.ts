import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { GoTrueAdminService } from '../users/gotrue-admin.service';
import { Branch } from './branch.entity';
import { BranchesController } from './branches.controller';
import { BranchesService } from './branches.service';

@Module({
  imports: [TypeOrmModule.forFeature([Branch]), AuthModule],
  controllers: [BranchesController],
  // GoTrueAdminService (from the Users module) provisions a new owner's login.
  providers: [BranchesService, GoTrueAdminService],
})
export class BranchesModule {}
