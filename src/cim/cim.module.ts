import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { CimController } from './cim.controller';
import { CimService } from './cim.service';
import { Customer } from './customer.entity';

/**
 * CIM module (customer search + inline registration). CimService is exported so
 * the SRD module can reuse it to validate a customer when linking one onto a
 * Service Request — mirroring how FleetModule exports FleetService for dispatch.
 * CIM does NOT import SRD (the dependency runs SRD → CIM only), so the customer
 * "last order date" aggregate reads srd.service_requests by table name rather
 * than via the SRD entity, avoiding a module cycle.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Customer]), AuthModule],
  controllers: [CimController],
  providers: [CimService],
  exports: [CimService],
})
export class CimModule {}
