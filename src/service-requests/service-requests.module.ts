import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { FleetModule } from '../fleet/fleet.module';
import { ServiceRequest } from './service-request.entity';
import { ServiceRequestsController } from './service-requests.controller';
import { ServiceRequestsService } from './service-requests.service';

@Module({
  // FleetModule exports FleetService, which the dispatch flow uses to validate
  // a rider and flip them to 'On Delivery' (mirrors BranchesModule reusing the
  // Users module's GoTrueAdminService).
  imports: [TypeOrmModule.forFeature([ServiceRequest]), AuthModule, FleetModule],
  controllers: [ServiceRequestsController],
  providers: [ServiceRequestsService],
})
export class ServiceRequestsModule {}
