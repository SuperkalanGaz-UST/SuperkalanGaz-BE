import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { Principal } from '../auth/principal';
import { Branch } from '../branches/branch.entity';
import { FleetService } from './fleet.service';
import { Rider } from './rider.entity';
import { Vehicle } from './vehicle.entity';
import { VehicleMaintenanceLog } from './vehicle-maintenance-log.entity';

/**
 * Unit coverage for the Fleet roster service. The focus is branch scoping and
 * the assignable-rider lookup the SRD dispatch flow relies on (panel-defense
 * points, AGENTS.md §5/§6), plus the vehicle mileage/PMS logic added for
 * BM-US-09, so all repositories are faked; no database is touched.
 */
describe('FleetService', () => {
  const makeRiderRepo = () =>
    ({
      find: jest.fn(() => Promise.resolve([])),
      findOne: jest.fn(() => Promise.resolve(null)),
      update: jest.fn(() => Promise.resolve({ affected: 1 })),
    }) as unknown as jest.Mocked<Repository<Rider>>;

  const makeVehicleRepo = (overrides: Partial<Vehicle> = {}) => {
    const vehicle: Vehicle = {
      id: 'vehicle-1',
      branchId: 'branch-uuid-1',
      plateNumber: 'NBH-1234',
      vehicleType: 'motorcycle',
      assignedRiderId: 'rider-1',
      status: 'active',
      currentOdometerKm: 1000,
      lastPmsOdometerKm: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
    return {
      find: jest.fn(() => Promise.resolve([vehicle])),
      findOne: jest.fn(() => Promise.resolve(vehicle)),
      update: jest.fn(() => Promise.resolve({ affected: 1 })),
      create: jest.fn((v) => v),
      __vehicle: vehicle,
    } as unknown as jest.Mocked<Repository<Vehicle>> & { __vehicle: Vehicle };
  };

  const makeLogRepo = () =>
    ({
      find: jest.fn(() => Promise.resolve([])),
      create: jest.fn((v) => v),
      save: jest.fn((v) => Promise.resolve(v)),
    }) as unknown as jest.Mocked<Repository<VehicleMaintenanceLog>>;

  const makeBranchRepo = (thresholdKm = 3000) =>
    ({
      find: jest.fn(() =>
        Promise.resolve([{ id: 'branch-uuid-1', maintenanceThresholdKm: thresholdKm }]),
      ),
      findOne: jest.fn(() =>
        Promise.resolve({ id: 'branch-uuid-1', maintenanceThresholdKm: thresholdKm } as Branch),
      ),
    }) as unknown as jest.Mocked<Repository<Branch>>;

  const makeService = (
    riderRepo = makeRiderRepo(),
    vehicleRepo = makeVehicleRepo(),
    logRepo = makeLogRepo(),
    branchRepo = makeBranchRepo(),
  ) => new FleetService(riderRepo, vehicleRepo, logRepo, branchRepo);

  const principal = (branchIds: string[]): Principal => ({
    userId: 'user-1',
    role: 'branch-manager',
    branches: ['Alpha'],
    branchIds,
  });

  it('scopes the roster to the caller branches and excludes soft-deleted rows', async () => {
    const repo = makeRiderRepo();
    const service = makeService(repo);

    await service.listForBranch(principal(['branch-uuid-1', 'branch-uuid-2']), {});

    const where = repo.find.mock.calls[0][0]?.where as Record<string, unknown>;
    expect(where).toHaveProperty('branchId');
    expect(where).toHaveProperty('deletedAt');
    // No status filter passed → the roster is not narrowed by status.
    expect(where).not.toHaveProperty('status');
    expect(repo.find.mock.calls[0][0]?.order).toEqual({ name: 'ASC' });
  });

  it('applies the optional status filter (the dispatch dropdown passes Available)', async () => {
    const repo = makeRiderRepo();
    const service = makeService(repo);

    await service.listForBranch(principal(['branch-uuid-1']), { status: 'Available' });

    const where = repo.find.mock.calls[0][0]?.where as Record<string, unknown>;
    expect(where.status).toBe('Available');
  });

  it('fails closed when the caller has no active branch', async () => {
    const repo = makeRiderRepo();
    const service = makeService(repo);

    await expect(
      service.listForBranch(principal([]), {}),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repo.find).not.toHaveBeenCalled();
  });

  it('looks up an assignable rider by id, branch, Available status, and live row', async () => {
    const repo = makeRiderRepo();
    const service = makeService(repo);

    await service.findAssignableRider('rider-1', 'branch-uuid-1');

    const where = repo.findOne.mock.calls[0][0]?.where as Record<string, unknown>;
    expect(where.id).toBe('rider-1');
    expect(where.branchId).toBe('branch-uuid-1');
    expect(where.status).toBe('Available');
    expect(where).toHaveProperty('deletedAt');
  });

  it('flips a rider to On Delivery and bumps updated_at', async () => {
    const repo = makeRiderRepo();
    const service = makeService(repo);

    await service.markOnDelivery('rider-1');

    expect(repo.update).toHaveBeenCalledTimes(1);
    const [criteria, patch] = repo.update.mock.calls[0];
    expect(criteria).toEqual({ id: 'rider-1' });
    expect((patch as Partial<Rider>).status).toBe('On Delivery');
    expect((patch as Partial<Rider>).updatedAt).toBeInstanceOf(Date);
  });

  it('returns a rider to Available when their vehicle is not under maintenance', async () => {
    const riderRepo = makeRiderRepo();
    const vehicleRepo = makeVehicleRepo();
    vehicleRepo.findOne.mockResolvedValueOnce(null); // no vehicle flagged 'maintenance' for this rider
    const service = makeService(riderRepo, vehicleRepo);

    await service.markAvailable('rider-1');

    expect(riderRepo.update).toHaveBeenCalledTimes(1);
    const [criteria, patch] = riderRepo.update.mock.calls[0];
    expect(criteria).toEqual({ id: 'rider-1' });
    expect((patch as Partial<Rider>).status).toBe('Available');
  });

  it('sends a rider to Maintenance Due instead of Available if their vehicle is flagged (BM-US-09)', async () => {
    const riderRepo = makeRiderRepo();
    const vehicleRepo = makeVehicleRepo({ status: 'maintenance' });
    const service = makeService(riderRepo, vehicleRepo);

    await service.markAvailable('rider-1');

    const [, patch] = riderRepo.update.mock.calls[0];
    expect((patch as Partial<Rider>).status).toBe('Maintenance Due');
  });

  it('logMileage flags the vehicle for maintenance once the branch threshold is reached', async () => {
    const riderRepo = makeRiderRepo();
    const vehicleRepo = makeVehicleRepo({ currentOdometerKm: 2900, lastPmsOdometerKm: 0 });
    const logRepo = makeLogRepo();
    const service = makeService(riderRepo, vehicleRepo, logRepo, makeBranchRepo(3000));

    const vehicle = await service.logMileage(principal(['branch-uuid-1']), 'vehicle-1', {
      odometerKm: 3000,
    });

    expect(vehicle.status).toBe('maintenance');
    const [, patch] = vehicleRepo.update.mock.calls[0];
    expect((patch as Partial<Vehicle>).status).toBe('maintenance');
    // Rider pulled out of the Available pool.
    const [riderCriteria, riderPatch] = riderRepo.update.mock.calls[0];
    expect(riderCriteria).toEqual({ id: 'rider-1', status: 'Available' });
    expect((riderPatch as Partial<Rider>).status).toBe('Maintenance Due');
    expect(logRepo.save).toHaveBeenCalledTimes(1);
  });

  it('logMileage does not flag maintenance below the threshold', async () => {
    const riderRepo = makeRiderRepo();
    const vehicleRepo = makeVehicleRepo({ currentOdometerKm: 1000, lastPmsOdometerKm: 0 });
    const service = makeService(riderRepo, vehicleRepo, makeLogRepo(), makeBranchRepo(3000));

    const vehicle = await service.logMileage(principal(['branch-uuid-1']), 'vehicle-1', {
      odometerKm: 1500,
    });

    expect(vehicle.status).toBe('active');
    expect(riderRepo.update).not.toHaveBeenCalled();
  });

  it('logMileage rejects a reading lower than the current odometer', async () => {
    const vehicleRepo = makeVehicleRepo({ currentOdometerKm: 1000 });
    const service = makeService(makeRiderRepo(), vehicleRepo);

    await expect(
      service.logMileage(principal(['branch-uuid-1']), 'vehicle-1', { odometerKm: 500 }),
    ).rejects.toThrow('Odometer reading cannot be lower than the current reading');
  });

  it('logMileage throws 409 when a concurrent submission already advanced the odometer', async () => {
    const vehicleRepo = makeVehicleRepo({ currentOdometerKm: 1000 });
    vehicleRepo.update.mockResolvedValueOnce({ affected: 0 } as never);
    const service = makeService(makeRiderRepo(), vehicleRepo);

    await expect(
      service.logMileage(principal(['branch-uuid-1']), 'vehicle-1', { odometerKm: 1200 }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('logMileage 404s when the vehicle is unknown or out of branch', async () => {
    const vehicleRepo = makeVehicleRepo();
    vehicleRepo.findOne.mockResolvedValueOnce(null);
    const service = makeService(makeRiderRepo(), vehicleRepo);

    await expect(
      service.logMileage(principal(['branch-uuid-1']), 'vehicle-1', { odometerKm: 1200 }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('resetPms clears the maintenance flag and resets the PMS baseline', async () => {
    const riderRepo = makeRiderRepo();
    const vehicleRepo = makeVehicleRepo({
      status: 'maintenance',
      currentOdometerKm: 3200,
      lastPmsOdometerKm: 0,
    });
    const service = makeService(riderRepo, vehicleRepo);

    const vehicle = await service.resetPms(principal(['branch-uuid-1']), 'vehicle-1');

    expect(vehicle.status).toBe('active');
    expect(vehicle.lastPmsOdometerKm).toBe(3200);
    const [, patch] = riderRepo.update.mock.calls[0];
    expect((patch as Partial<Rider>).status).toBe('Available');
  });

  it('resetPms throws 409 when the vehicle is not currently flagged', async () => {
    const vehicleRepo = makeVehicleRepo({ status: 'active' });
    vehicleRepo.update.mockResolvedValueOnce({ affected: 0 } as never);
    const service = makeService(makeRiderRepo(), vehicleRepo);

    await expect(
      service.resetPms(principal(['branch-uuid-1']), 'vehicle-1'),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
