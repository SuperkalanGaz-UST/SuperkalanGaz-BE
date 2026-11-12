import { BranchOwnerInvitationsService } from './branch-owner-invitations.service';
import { ConfigModule } from '@nestjs/config';
import { BranchGeocodingService } from './branch-geocoding.service';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { GovernanceModule } from '../governance/governance.module';
import { GoTrueAdminService } from '../users/gotrue-admin.service';
import { Branch } from './branch.entity';
import { BranchesController } from './branches.controller';
import { BranchesService } from './branches.service';

@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature([Branch]), AuthModule, GovernanceModule],
  controllers: [BranchesController],
  // GoTrueAdminService provisions protected branch_ids claims and keeps the
  // display-only branch-name projection aligned after a rename.
  providers: [BranchOwnerInvitationsService, BranchesService, GoTrueAdminService, BranchGeocodingService],
})
export class BranchesModule {}
