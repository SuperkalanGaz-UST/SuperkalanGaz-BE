import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { Branch } from '../branches/branch.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { PricesModule } from '../prices/prices.module';
import { SlaConfiguration } from '../service-requests/sla-configuration.entity';
import { UsersModule } from '../users/users.module';
import { GovernanceAuditModule } from './governance-audit.module';
import { GovernanceController } from './governance.controller';
import { GovernanceRequest } from './governance-request.entity';
import { GovernanceService } from './governance.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([GovernanceRequest, Branch, SlaConfiguration]),
    AuthModule,
    UsersModule,
    PricesModule,
    NotificationsModule,
    GovernanceAuditModule,
  ],
  controllers: [GovernanceController],
  providers: [GovernanceService],
  exports: [GovernanceAuditModule],
})
export class GovernanceModule {}
