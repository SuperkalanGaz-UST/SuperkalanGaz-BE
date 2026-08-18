import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { Principal } from '../auth/principal';
import { CurrentPrincipal, Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { CreateVehicleDto } from './dto/create-vehicle.dto';
import { LogMileageDto } from './dto/log-mileage.dto';
import { FleetService } from './fleet.service';
import { Vehicle } from './vehicle.entity';
import { VehicleMaintenanceLog } from './vehicle-maintenance-log.entity';

/**
 * Vehicle roster + mileage/PMS tracking (story BM-US-09). Branch Manager only —
 * unlike /riders/:id, there is no customer-facing use case here, so this
 * controller never widens @Roles beyond the class-level 'branch-manager'.
 */
@Controller('vehicles')
@UseGuards(AuthGuard, RolesGuard)
@Roles('branch-manager')
export class VehiclesController {
  constructor(private readonly fleet: FleetService) {}

  @Post()
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: CreateVehicleDto,
  ): Promise<{ vehicle: ReturnType<VehiclesController['toRow']> }> {
    const vehicle = await this.fleet.registerVehicle(principal, dto);
    const [riderNames, thresholds] = await Promise.all([
      this.fleet.riderNamesFor(this.assignedRiderIds([vehicle])),
      this.fleet.maintenanceThresholdsForBranches([vehicle.branchId]),
    ]);
    return { vehicle: this.toRow(vehicle, riderNames, thresholds) };
  }

  @Get()
  async list(
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ vehicles: ReturnType<VehiclesController['toRow']>[] }> {
    const vehicles = await this.fleet.listVehiclesForBranch(principal);
    const [riderNames, thresholds] = await Promise.all([
      this.fleet.riderNamesFor(this.assignedRiderIds(vehicles)),
      this.fleet.maintenanceThresholdsForBranches([...new Set(vehicles.map((v) => v.branchId))]),
    ]);
    return { vehicles: vehicles.map((v) => this.toRow(v, riderNames, thresholds)) };
  }

  @Get(':id')
  async detail(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{
    vehicle: ReturnType<VehiclesController['toRow']>;
    maintenanceLogs: ReturnType<VehiclesController['toLogRow']>[];
  }> {
    const vehicle = await this.fleet.getVehicle(principal, id);
    const [riderNames, thresholds, logs] = await Promise.all([
      this.fleet.riderNamesFor(this.assignedRiderIds([vehicle])),
      this.fleet.maintenanceThresholdsForBranches([vehicle.branchId]),
      this.fleet.listMaintenanceLogs(principal, id),
    ]);
    return {
      vehicle: this.toRow(vehicle, riderNames, thresholds),
      maintenanceLogs: logs.map((l) => this.toLogRow(l)),
    };
  }

  @Post(':id/mileage')
  async logMileage(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LogMileageDto,
  ): Promise<{ vehicle: ReturnType<VehiclesController['toRow']> }> {
    const vehicle = await this.fleet.logMileage(principal, id, dto);
    const [riderNames, thresholds] = await Promise.all([
      this.fleet.riderNamesFor(this.assignedRiderIds([vehicle])),
      this.fleet.maintenanceThresholdsForBranches([vehicle.branchId]),
    ]);
    return { vehicle: this.toRow(vehicle, riderNames, thresholds) };
  }

  @Post(':id/reset-pms')
  async resetPms(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ vehicle: ReturnType<VehiclesController['toRow']> }> {
    const vehicle = await this.fleet.resetPms(principal, id);
    const [riderNames, thresholds] = await Promise.all([
      this.fleet.riderNamesFor(this.assignedRiderIds([vehicle])),
      this.fleet.maintenanceThresholdsForBranches([vehicle.branchId]),
    ]);
    return { vehicle: this.toRow(vehicle, riderNames, thresholds) };
  }

  private assignedRiderIds(vehicles: Vehicle[]): string[] {
    return vehicles
      .map((v) => v.assignedRiderId)
      .filter((id): id is string => id !== null);
  }

  /** Snake_case response row, matching the precedent in FleetController.toRow. */
  private toRow(
    vehicle: Vehicle,
    riderNames: Map<string, string>,
    thresholds: Map<string, number>,
  ) {
    return {
      id: vehicle.id,
      branch_id: vehicle.branchId,
      plate_number: vehicle.plateNumber,
      vehicle_type: vehicle.vehicleType,
      assigned_rider_id: vehicle.assignedRiderId,
      assigned_rider_name: vehicle.assignedRiderId
        ? (riderNames.get(vehicle.assignedRiderId) ?? null)
        : null,
      status: vehicle.status,
      current_odometer_km: vehicle.currentOdometerKm,
      last_pms_odometer_km: vehicle.lastPmsOdometerKm,
      km_since_last_pms: vehicle.currentOdometerKm - vehicle.lastPmsOdometerKm,
      maintenance_threshold_km: thresholds.get(vehicle.branchId) ?? 3000,
      updated_at: vehicle.updatedAt,
    };
  }

  private toLogRow(log: VehicleMaintenanceLog) {
    return {
      id: log.id,
      vehicle_id: log.vehicleId,
      odometer_km: log.odometerKm,
      fuel_liters: log.fuelLiters,
      logged_by: log.loggedBy,
      logged_at: log.loggedAt,
    };
  }
}
