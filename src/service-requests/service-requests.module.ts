import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { Branch } from '../branches/branch.entity';
import { CimModule } from '../cim/cim.module';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { FleetModule } from '../fleet/fleet.module';
import { PricesModule } from '../prices/prices.module';
import { ServiceRequest } from './service-request.entity';
import { ServiceRequestStatusHistory } from './service-request-status-history.entity';
import { SlaConfiguration } from './sla-configuration.entity';
import { ServiceRequestsController } from './service-requests.controller';
import { DeliveryRiderServiceRequestsController } from './delivery-rider-service-requests.controller';
import { ServiceRequestsService } from './service-requests.service';
import { PayMongoController } from './paymongo.controller';
import { PayMongoService } from './paymongo.service';
import { ServiceRequestPaymentsService } from './service-request-payments.service';
import { ServiceRequestDeliveryProof } from './service-request-delivery-proof.entity';
import { PrivateObjectStorageService } from '../storage/private-object-storage.service';

@Module({
  // FleetModule exports FleetService (validate a rider and flip them to 'On
  // Delivery' at dispatch); CimModule exports CimService (validate a customer
  // when linking one onto a request at create). Both mirror BranchesModule
  // reusing the Users module's GoTrueAdminService. The dependency runs SRD → CIM
  // only (CIM never imports SRD), so there is no module cycle. SlaConfiguration
  // is registered READ-ONLY (BM-US-02) — this module never writes to it.
  imports: [
    TypeOrmModule.forFeature([
      ServiceRequest,
      ServiceRequestStatusHistory,
      SlaConfiguration,
      Branch,
      ServiceRequestDeliveryProof,
    ]),
    AuthModule,
    LoyaltyModule,
    FleetModule,
    CimModule,
    PricesModule,
  ],
  controllers: [
    ServiceRequestsController,
    DeliveryRiderServiceRequestsController,
    PayMongoController,
  ],
  providers: [
    ServiceRequestsService,
    ServiceRequestPaymentsService,
    PayMongoService,
    PrivateObjectStorageService,
  ],
})
export class ServiceRequestsModule {}
