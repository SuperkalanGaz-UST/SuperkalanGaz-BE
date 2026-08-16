import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { Branch } from '../branches/branch.entity';
import { FleetController } from './fleet.controller';
import { FleetService } from './fleet.service';
import { Rider } from './rider.entity';
import { Vehicle } from './vehicle.entity';
import { VehicleMaintenanceLog } from './vehicle-maintenance-log.entity';
import { VehiclesController } from './vehicles.controller';

/**
 * Fleet module (rider roster + dispatch validation, and vehicle mileage/PMS
 * tracking — story BM-US-09). FleetService is exported so the SRD module can
 * reuse it to validate a rider at dispatch time — mirroring how BranchesModule
 * reuses GoTrueAdminService from the Users module.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Rider, Vehicle, VehicleMaintenanceLog, Branch]),
    AuthModule,
  ],
  controllers: [FleetController, VehiclesController],
  providers: [FleetService],
  exports: [FleetService],
})
export class FleetModule {}
