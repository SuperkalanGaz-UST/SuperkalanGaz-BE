import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { GoTrueAdminService } from '../users/gotrue-admin.service';
import { Profile } from '../users/profile.entity';
import { Branch } from './branch.entity';
import { BranchesController } from './branches.controller';
import { BranchesService } from './branches.service';

@Module({
  // Profile is registered so a branch rename can cascade to the branch names
  // stored on profiles.branches (tenancy is keyed by branch name — AGENTS.md §5).
  imports: [TypeOrmModule.forFeature([Branch, Profile]), AuthModule],
  controllers: [BranchesController],
  // GoTrueAdminService (from the Users module) provisions a new owner's login.
  providers: [BranchesService, GoTrueAdminService],
})
export class BranchesModule {}
