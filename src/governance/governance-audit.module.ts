import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GovernanceAuditEvent } from './governance-audit-event.entity';
import { GovernanceAuditService } from './governance-audit.service';

/**
 * Split out of GovernanceModule so UsersModule can also write audit events
 * (M1 fix: admin credential changes need an audit trail) without a module
 * cycle — GovernanceModule already imports UsersModule.
 */
@Module({
  imports: [TypeOrmModule.forFeature([GovernanceAuditEvent])],
  providers: [GovernanceAuditService],
  exports: [GovernanceAuditService],
})
export class GovernanceAuditModule {}
