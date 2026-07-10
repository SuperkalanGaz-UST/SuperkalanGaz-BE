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
  // GoTrueAdminService (from the Users module) provisions a new owner's login and
  // cascades branch renames into each owner/manager's app_metadata.branches
  // (tenancy is keyed by branch name — AGENTS.md §5).
  providers: [BranchesService, GoTrueAdminService],
})
export class BranchesModule {}
