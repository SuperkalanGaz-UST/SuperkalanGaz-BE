import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { Principal } from '../auth/principal';
import { CurrentPrincipal, Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { ConnectVehicleGpsDto } from './dto/connect-vehicle-gps.dto';
import { CreateVehicleDto } from './dto/create-vehicle.dto';
import { VehicleBranchQuery } from './dto/vehicle-branch.query';
import { LogMileageDto } from './dto/log-mileage.dto';
import { FleetService } from './fleet.service';
import { Vehicle } from './vehicle.entity';
import { VehicleMaintenanceLog } from './vehicle-maintenance-log.entity';
import { GpsMileageService, GpsMileageInfo } from './traccar/gps-mileage.service';

/**
 * Vehicle roster and history are view-only for Branch Owners in their selected
 * live branch. The class-level Branch Manager restriction remains on every write.
 */
@Controller('vehicles')
@UseGuards(AuthGuard, RolesGuard)
@Roles('branch-manager')
export class VehiclesController {
  constructor(private readonly fleet: FleetService, private readonly gpsMileage: GpsMileageService) {}

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
  @Roles('branch-manager', 'branch-owner')
  async list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: VehicleBranchQuery,
  ): Promise<{ vehicles: ReturnType<VehiclesController['toRow']>[]; gps_refresh_interval_ms: number }> {
    // Owner reads use saved mileage; they do not trigger operational telemetry writes.
    const mileage = principal.role === 'branch-manager'
      ? await this.gpsMileage.refresh(principal)
      : null;
    const vehicles = await this.fleet.listVehiclesForBranch(principal, query.branchId);
    const [riderNames, thresholds] = await Promise.all([
      this.fleet.riderNamesFor(this.assignedRiderIds(vehicles)),
      this.fleet.maintenanceThresholdsForBranches([...new Set(vehicles.map((v) => v.branchId))]),
    ]);
    return {
      vehicles: vehicles.map((v) => this.toRow(v, riderNames, thresholds, mileage ? (mileage.get(v.id) ?? {
        status: this.gpsMileage.enabled ? 'waiting' : 'disabled', position_at: null, synced_at: null,
      }) : undefined)),
      gps_refresh_interval_ms: this.gpsMileage.intervalMs,
    };
  }

  @Get(':id')
  @Roles('branch-manager', 'branch-owner')
  async detail(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: VehicleBranchQuery,
  ): Promise<{
    vehicle: ReturnType<VehiclesController['toRow']>;
    maintenanceLogs: ReturnType<VehiclesController['toLogRow']>[];
  }> {
    const vehicle = await this.fleet.getVehicle(principal, id, query.branchId);
    const [riderNames, thresholds, logs] = await Promise.all([
      this.fleet.riderNamesFor(this.assignedRiderIds([vehicle])),
      this.fleet.maintenanceThresholdsForBranches([vehicle.branchId]),
      this.fleet.listMaintenanceLogs(principal, id, query.branchId),
    ]);
    return {
      vehicle: this.toRow(vehicle, riderNames, thresholds),
      maintenanceLogs: logs.map((l) => this.toLogRow(l)),
    };
  }

  @Post(':id/retry-gps-provisioning')
  async retryGpsProvisioning(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ vehicle: ReturnType<VehiclesController['toRow']> }> {
    const vehicle = await this.fleet.retryVehicleProvisioning(principal, id);
    const [riderNames, thresholds] = await Promise.all([
      this.fleet.riderNamesFor(this.assignedRiderIds([vehicle])),
      this.fleet.maintenanceThresholdsForBranches([vehicle.branchId]),
    ]);
    return { vehicle: this.toRow(vehicle, riderNames, thresholds) };
  }

  @Post(':id/gps-provisioning')
  async connectGps(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConnectVehicleGpsDto,
  ): Promise<{ vehicle: ReturnType<VehiclesController['toRow']> }> {
    const vehicle = await this.fleet.connectVehicleGps(principal, id, dto);
    const [riderNames, thresholds] = await Promise.all([
      this.fleet.riderNamesFor(this.assignedRiderIds([vehicle])),
      this.fleet.maintenanceThresholdsForBranches([vehicle.branchId]),
    ]);
    return { vehicle: this.toRow(vehicle, riderNames, thresholds) };
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
    gpsMileage?: GpsMileageInfo,
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
      gps_provisioning_status: vehicle.traccarProvisioningStatus,
      gps_provisioning_error: vehicle.traccarProvisioningError,
      gps_provisioned_at: vehicle.traccarProvisionedAt,
      gps_mileage: gpsMileage ?? null,
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
