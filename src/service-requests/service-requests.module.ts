import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { CimModule } from '../cim/cim.module';
import { FleetModule } from '../fleet/fleet.module';
import { PricesModule } from '../prices/prices.module';
import { ServiceRequest } from './service-request.entity';
import { ServiceRequestStatusHistory } from './service-request-status-history.entity';
import { ServiceRequestsController } from './service-requests.controller';
import { ServiceRequestsService } from './service-requests.service';

@Module({
  // FleetModule exports FleetService (validate a rider and flip them to 'On
  // Delivery' at dispatch); CimModule exports CimService (validate a customer
  // when linking one onto a request at create). Both mirror BranchesModule
  // reusing the Users module's GoTrueAdminService. The dependency runs SRD → CIM
  // only (CIM never imports SRD), so there is no module cycle.
  imports: [
    TypeOrmModule.forFeature([ServiceRequest, ServiceRequestStatusHistory]),
    AuthModule,
    FleetModule,
    CimModule,
    PricesModule,
  ],
  controllers: [ServiceRequestsController],
  providers: [ServiceRequestsService],
})
export class ServiceRequestsModule {}
