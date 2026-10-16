import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FranchiseReportsController } from './franchise-reports.controller';
import { FranchiseReportsService } from './franchise-reports.service';

@Module({
  imports: [AuthModule],
  controllers: [FranchiseReportsController],
  providers: [FranchiseReportsService],
})
export class FranchiseReportsModule {}
