import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { FleetController } from './fleet.controller';
import { FleetService } from './fleet.service';
import { Rider } from './rider.entity';

/**
 * Fleet module (rider roster + dispatch validation). FleetService is exported so
 * the SRD module can reuse it to validate a rider at dispatch time — mirroring
 * how BranchesModule reuses GoTrueAdminService from the Users module.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Rider]), AuthModule],
  controllers: [FleetController],
  providers: [FleetService],
  exports: [FleetService],
})
export class FleetModule {}
