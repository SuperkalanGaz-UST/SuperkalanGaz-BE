import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, LessThanOrEqual, Repository } from 'typeorm';
import { Principal } from '../auth/principal';
import { Branch } from '../branches/branch.entity';
import { ListRidersQuery } from './dto/list-riders.query';
import { LogMileageDto } from './dto/log-mileage.dto';
import { Rider } from './rider.entity';
import { Vehicle } from './vehicle.entity';
import { VehicleMaintenanceLog } from './vehicle-maintenance-log.entity';

/**
 * Fleet roster (Fleet module). This slice is minimal: list the caller's branch
 * riders for the dispatch dropdown, and an internal lookup the SRD service reuses
 * to validate a rider at dispatch time. No rider CRUD (riders are seeded
 * manually for now) and no GPS/Traccar — that is hardware-dependent and deferred
 * (AGENTS.md §8/§11).
 *
 * All scoping derives from the verified Principal, never from request input
 * (AGENTS.md §5). Isolation is enforced here in the application layer, not by the
 * DB — a missing branch filter is a cross-tenant leak.
 */
@Injectable()
export class FleetService {
  constructor(
    @InjectRepository(Rider)
    private readonly riders: Repository<Rider>,
    @InjectRepository(Vehicle)
    private readonly vehicles: Repository<Vehicle>,
    @InjectRepository(VehicleMaintenanceLog)
    private readonly maintenanceLogs: Repository<VehicleMaintenanceLog>,
    @InjectRepository(Branch)
    private readonly branches: Repository<Branch>,
  ) {}

  /**
   * The caller's branch roster: live riders for their own branch(es) only,
   * excluding soft-deleted rows. An optional status filter (validated upstream)
   * narrows the list — the dispatch dropdown passes 'Available'. Branch scope
   * comes from the principal; request input can never widen it (AGENTS.md §5).
   */
  async listForBranch(
    principal: Principal,
    query: ListRidersQuery,
  ): Promise<Rider[]> {
    const branchIds = this.requireBranches(principal);

    return this.riders.find({
      where: {
        branchId: In(branchIds),
        deletedAt: IsNull(),
        ...(query.status ? { status: query.status } : {}),
      },
      order: { name: 'ASC' },
    });
  }

  /**
   * Internal lookup used by the SRD dispatch flow to confirm a rider is
   * assignable to a Service Request: the rider exists, is not soft-deleted,
   * belongs to the SAME branch as the request, and is currently 'Available'.
   * Returns null when any of those fail — the caller turns that into a
   * BadRequestException. Referential integrity is checked here in the service
   * layer; the schema has no FK constraints by design (AGENTS.md §6).
   */
  async findAssignableRider(
    riderId: string,
    branchId: string,
  ): Promise<Rider | null> {
    return this.riders.findOne({
      where: {
        id: riderId,
        branchId,
        status: 'Available',
        deletedAt: IsNull(),
      },
    });
  }

  /**
   * Look up a rider by id, scoped to the SAME branch, regardless of their
   * current status. Used by the SRD reassignment flow (story BM-010) to load
   * the CURRENTLY assigned rider — who is 'On Delivery', not 'Available', so
   * findAssignableRider (status-filtered) cannot find them. Mirrors
   * CimService.findInBranch's naming/shape. Returns null if unknown,
   * soft-deleted, or in another branch.
   */
  async findInBranch(riderId: string, branchId: string): Promise<Rider | null> {
    return this.riders.findOne({
      where: { id: riderId, branchId, deletedAt: IsNull() },
    });
  }

  /**
   * Look up a rider by id globally (used for customers viewing their assigned rider).
   */
  async findById(riderId: string): Promise<Rider | null> {
    return this.riders.findOne({
      where: { id: riderId, deletedAt: IsNull() },
    });
  }

  /**
   * Flip a rider to 'On Delivery' so they drop out of the Available list once
   * dispatched — prevents another Service Request picking the same rider. The
   * rider returns to 'Available' in the later "mark delivered" slice (Slice 3).
   */
  async markOnDelivery(riderId: string): Promise<void> {
    await this.riders.update(
      { id: riderId },
      { status: 'On Delivery', updatedAt: new Date() },
    );
  }

  /**
   * Return a rider to 'Available' once their Service Request is marked delivered
   * (Slice 3, story BM-007) — the inverse of markOnDelivery. Puts the rider back
   * on the dispatch roster so the branch can assign them to the next order.
   *
   * Vehicle-aware (story BM-US-09): if the rider's assigned vehicle was flagged
   * 'maintenance' while they were out (logMileage can fire mid-delivery), they go
   * to 'Maintenance Due' instead of 'Available' — otherwise this unconditional
   * "delivery done" transition would silently clear a maintenance flag BM-045
   * requires to stick until an explicit PMS reset.
   */
  async markAvailable(riderId: string): Promise<void> {
    const dueForMaintenance = await this.vehicles.findOne({
      where: { assignedRiderId: riderId, status: 'maintenance' },
    });
    await this.riders.update(
      { id: riderId },
      {
        status: dueForMaintenance ? 'Maintenance Due' : 'Available',
        updatedAt: new Date(),
      },
    );
  }

  /** The caller's branch vehicle roster (story BM-042), plate order. */
  async listVehiclesForBranch(principal: Principal): Promise<Vehicle[]> {
    const branchIds = this.requireBranches(principal);
    return this.vehicles.find({
      where: { branchId: In(branchIds) },
      order: { plateNumber: 'ASC' },
    });
  }

  /** A single vehicle, scoped to the caller's branch(es). 404 if unknown or
   * out-of-branch — never distinguishes the two to the caller. */
  async getVehicle(principal: Principal, vehicleId: string): Promise<Vehicle> {
    const branchIds = this.requireBranches(principal);
    const vehicle = await this.vehicles.findOne({
      where: { id: vehicleId, branchId: In(branchIds) },
    });
    if (!vehicle) throw new NotFoundException('Vehicle not found');
    return vehicle;
  }

  /** Maintenance log history for a vehicle detail view (story BM-043's "appears
   * in the vehicle's maintenance log history"), newest first. */
  async listMaintenanceLogs(
    principal: Principal,
    vehicleId: string,
  ): Promise<VehicleMaintenanceLog[]> {
    const branchIds = this.requireBranches(principal);
    return this.maintenanceLogs.find({
      where: { vehicleId, branchId: In(branchIds) },
      order: { loggedAt: 'DESC' },
      take: 50,
    });
  }

  /**
   * Log an odometer/fuel reading against a vehicle (story BM-043) and, when the
   * distance since the last PMS reaches the branch's configured threshold,
   * automatically flag the vehicle 'maintenance' (BM-044) and — if a rider is
   * currently assigned and Available — pull them out of the dispatch pool
   * (BM-045, reusing the pre-existing 'Maintenance Due' rider status).
   *
   * The odometer update is race-safe: two concurrent submissions can't both
   * "win" with a lower reading clobbering a higher one already saved (0 rows
   * affected => 409), mirroring the project's other guarded UPDATE...WHERE
   * patterns (e.g. CsatService.resolveRating).
   */
  async logMileage(
    principal: Principal,
    vehicleId: string,
    dto: LogMileageDto,
  ): Promise<Vehicle> {
    const branchIds = this.requireBranches(principal);
    const vehicle = await this.vehicles.findOne({
      where: { id: vehicleId, branchId: In(branchIds) },
    });
    if (!vehicle) throw new NotFoundException('Vehicle not found');
    if (dto.odometerKm < vehicle.currentOdometerKm) {
      throw new BadRequestException(
        'Odometer reading cannot be lower than the current reading',
      );
    }

    const branch = await this.branches.findOne({ where: { id: vehicle.branchId } });
    const threshold = branch?.maintenanceThresholdKm ?? 3000;
    const dueForMaintenance = dto.odometerKm - vehicle.lastPmsOdometerKm >= threshold;
    const now = new Date();

    const result = await this.vehicles.update(
      { id: vehicle.id, currentOdometerKm: LessThanOrEqual(dto.odometerKm) },
      {
        currentOdometerKm: dto.odometerKm,
        updatedAt: now,
        ...(dueForMaintenance ? { status: 'maintenance' } : {}),
      },
    );
    if (!result.affected) {
      throw new ConflictException(
        'A newer odometer reading was already recorded for this vehicle',
      );
    }

    if (dueForMaintenance && vehicle.assignedRiderId) {
      await this.riders.update(
        { id: vehicle.assignedRiderId, status: 'Available' },
        { status: 'Maintenance Due', updatedAt: now },
      );
    }

    const loggedAt = dto.loggedAt ? new Date(dto.loggedAt) : now;
    await this.maintenanceLogs.save(
      this.maintenanceLogs.create({
        vehicleId: vehicle.id,
        branchId: vehicle.branchId,
        odometerKm: dto.odometerKm,
        fuelLiters: dto.fuelLiters ?? null,
        loggedBy: principal.userId,
        loggedAt,
        createdAt: now,
      }),
    );

    vehicle.currentOdometerKm = dto.odometerKm;
    vehicle.updatedAt = now;
    if (dueForMaintenance) vehicle.status = 'maintenance';
    return vehicle;
  }

  /**
   * Clear a vehicle's maintenance flag after servicing (BM-045's "clearing the
   * flag requires a new mileage entry showing the vehicle has been serviced and
   * the counter reset"): resets the PMS baseline to the current odometer and
   * returns the vehicle — and its assigned rider, if any — to service.
   * Race-safe: only fires from status='maintenance' (0 rows => 409).
   */
  async resetPms(principal: Principal, vehicleId: string): Promise<Vehicle> {
    const branchIds = this.requireBranches(principal);
    const vehicle = await this.vehicles.findOne({
      where: { id: vehicleId, branchId: In(branchIds) },
    });
    if (!vehicle) throw new NotFoundException('Vehicle not found');

    const now = new Date();
    const result = await this.vehicles.update(
      { id: vehicle.id, status: 'maintenance' },
      { lastPmsOdometerKm: vehicle.currentOdometerKm, status: 'active', updatedAt: now },
    );
    if (!result.affected) {
      throw new ConflictException('Vehicle is not currently flagged for maintenance');
    }

    if (vehicle.assignedRiderId) {
      await this.riders.update(
        { id: vehicle.assignedRiderId, status: 'Maintenance Due' },
        { status: 'Available', updatedAt: now },
      );
    }

    vehicle.lastPmsOdometerKm = vehicle.currentOdometerKm;
    vehicle.status = 'active';
    vehicle.updatedAt = now;
    return vehicle;
  }

  /** Resolve rider names by id (no branch filter — callers already scoped the
   * vehicles the ids came from). Mirrors CsatService.riderNames. */
  async riderNamesFor(riderIds: string[]): Promise<Map<string, string>> {
    if (riderIds.length === 0) return new Map();
    const riders = await this.riders.find({ where: { id: In(riderIds) } });
    return new Map(riders.map((r) => [r.id, r.name]));
  }

  /** Batched branch maintenance-threshold lookup, mirroring
   * ServiceRequestsService.resolveThresholdsForBranches (BM-US-02) so a vehicle
   * list of N rows across a handful of branches costs one query, not N. */
  async maintenanceThresholdsForBranches(
    branchIds: string[],
  ): Promise<Map<string, number>> {
    if (branchIds.length === 0) return new Map();
    const rows = await this.branches.find({ where: { id: In(branchIds) } });
    return new Map(rows.map((b) => [b.id, b.maintenanceThresholdKm]));
  }

  /** The caller's active branch UUIDs; fails closed if they have none. */
  private requireBranches(principal: Principal): string[] {
    if (principal.branchIds.length === 0) {
      throw new ForbiddenException('Caller has no active branch');
    }
    return principal.branchIds;
  }
}
