import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { Principal } from '../auth/principal';
import { Branch } from '../branches/branch.entity';
import { ServiceRequest } from '../service-requests/service-request.entity';
import { FleetService } from './fleet.service';
import { Rider } from './rider.entity';
import { Vehicle } from './vehicle.entity';
import { VehicleMaintenanceLog } from './vehicle-maintenance-log.entity';
import { TraccarClient } from './traccar/traccar.client';

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
      hardwareUniqueId: '867530900000001',
      traccarDeviceId: '41',
      traccarProvisioningStatus: 'provisioned',
      traccarProvisioningError: null,
      traccarProvisionedAt: new Date(),
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
      save: jest.fn((v) => Promise.resolve({ id: 'vehicle-new', ...v })),
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

  const makeServiceRequestRepo = (updateAffected = 1) => {
    const execute = jest.fn(() => Promise.resolve({ affected: updateAffected }));
    const qb = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute,
    };
    return {
      findOne: jest.fn(() => Promise.resolve(null)),
      createQueryBuilder: jest.fn(() => qb),
      __qb: qb,
    } as unknown as jest.Mocked<Repository<ServiceRequest>> & { __qb: typeof qb };
  };

  const makeTraccar = () =>
    ({
      provisionDevice: jest.fn(() =>
        Promise.resolve({
          id: 77,
          name: 'ABC-1234',
          uniqueId: '867530900000002',
        }),
      ),
    }) as unknown as jest.Mocked<TraccarClient>;

  const makeService = (
    riderRepo = makeRiderRepo(),
    vehicleRepo = makeVehicleRepo(),
    logRepo = makeLogRepo(),
    branchRepo = makeBranchRepo(),
    traccar = makeTraccar(),
    serviceRequestRepo = makeServiceRequestRepo(),
  ) => new FleetService(
    riderRepo,
    vehicleRepo,
    logRepo,
    branchRepo,
    traccar,
    serviceRequestRepo,
  );

  const principal = (branchIds: string[]): Principal => ({
    userId: 'user-1',
    role: 'branch-manager',
    branches: ['Alpha'],
    branchIds,
  });

  const branchOwnerPrincipal = (branchIds: string[]): Principal => ({
    userId: 'owner-1',
    role: 'branch-owner',
    branches: ['Alpha'],
    branchIds,
  });

  const driverPrincipal = (branchIds: string[]): Principal => ({
    userId: 'driver-user-1',
    role: 'driver',
    branches: ['Alpha'],
    branchIds,
  });

  it('returns the rider assignment on the mobile dashboard after dispatch', async () => {
    const riderRepo = makeRiderRepo();
    riderRepo.findOne.mockResolvedValueOnce({
      id: 'rider-1',
      authUserId: 'driver-user-1',
      branchId: 'branch-uuid-1',
      name: 'Lily Cruz',
      status: 'On Delivery',
      deletedAt: null,
    } as Rider);
    const serviceRequestRepo = makeServiceRequestRepo();
    const requestedAt = new Date('2026-09-01T06:00:00.000Z');
    const dispatchedAt = new Date('2026-09-01T06:15:00.000Z');
    const activeRequest = {
      id: 'service-request-1',
      srCode: 'SR-00001',
      branchId: 'branch-uuid-1',
      riderId: 'rider-1',
      status: 'Dispatched',
      customerName: 'Customer One',
      deliveryAddress: 'Las Pinas 1',
      cylinderSize: '11kg',
      quantity: 2,
      requestedAt,
      dispatchedAt,
      inTransitAt: null,
      deliveredAt: null,
      deletedAt: null,
    } as ServiceRequest;
    serviceRequestRepo.findOne.mockResolvedValueOnce(activeRequest);
    const service = makeService(
      riderRepo,
      makeVehicleRepo(),
      makeLogRepo(),
      makeBranchRepo(),
      makeTraccar(),
      serviceRequestRepo,
    );

    const dashboard = await service.deliveryRiderDashboard(
      driverPrincipal(['branch-uuid-1']),
    );

    expect(serviceRequestRepo.findOne).toHaveBeenCalledWith({
      where: expect.objectContaining({
        branchId: 'branch-uuid-1',
        riderId: 'rider-1',
        status: expect.anything(),
        deliveredAt: expect.anything(),
        deletedAt: expect.anything(),
      }),
      order: { dispatchedAt: 'DESC' },
    });
    expect(dashboard.activeDelivery).toEqual({
      serviceRequestId: 'service-request-1',
      srCode: 'SR-00001',
      customerName: 'Customer One',
      deliveryAddress: 'Las Pinas 1',
      cylinderSize: '11kg',
      quantity: 2,
      vehicleLabel: 'NBH-1234',
      requestedAt: requestedAt.toISOString(),
      dispatchedAt: dispatchedAt.toISOString(),
      inTransitAt: null,
    });
  });

  it('moves the assigned Service Request to En Route for the authenticated rider', async () => {
    const riderRepo = makeRiderRepo();
    riderRepo.findOne.mockResolvedValueOnce({
      id: 'rider-1',
      authUserId: 'driver-user-1',
      branchId: 'branch-uuid-1',
      status: 'On Delivery',
      deletedAt: null,
    } as Rider);
    const serviceRequestRepo = makeServiceRequestRepo();
    const service = makeService(
      riderRepo,
      makeVehicleRepo(),
      makeLogRepo(),
      makeBranchRepo(),
      makeTraccar(),
      serviceRequestRepo,
    );

    await service.markServiceRequestInTransit(
      driverPrincipal(['branch-uuid-1']),
      'service-request-1',
    );

    expect(serviceRequestRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
    expect(serviceRequestRepo.__qb.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'En Route', inTransitAt: expect.any(Date) }),
    );
    expect(serviceRequestRepo.__qb.where).toHaveBeenCalledWith(
      expect.stringContaining('rider_id = :riderId'),
      expect.objectContaining({
        serviceRequestId: 'service-request-1',
        branchId: 'branch-uuid-1',
        riderId: 'rider-1',
      }),
    );
    expect(serviceRequestRepo.__qb.execute).toHaveBeenCalledTimes(1);
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

  it('requires and validates a selected branch when a Branch Owner has multiple branches', async () => {
    const repo = makeRiderRepo();
    const service = makeService(repo);

    await expect(
      service.listForBranch(branchOwnerPrincipal(['branch-uuid-1', 'branch-uuid-2']), {}),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.listForBranch(
        branchOwnerPrincipal(['branch-uuid-1', 'branch-uuid-2']),
        { branchId: 'branch-uuid-3' },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repo.find).not.toHaveBeenCalled();
  });

  it('narrows a Branch Owner roster query to the selected authorized branch UUID', async () => {
    const repo = makeRiderRepo();
    const service = makeService(repo);

    await service.listForBranch(
      branchOwnerPrincipal(['branch-uuid-1', 'branch-uuid-2']),
      { branchId: 'branch-uuid-2' },
    );

    const where = repo.find.mock.calls[0][0]?.where as Record<string, unknown>;
    expect(where.branchId).toEqual(
      expect.objectContaining({ _type: 'in', _value: ['branch-uuid-2'] }),
    );
  });

  it('fails closed when the caller has no active branch', async () => {
    const repo = makeRiderRepo();
    const service = makeService(repo);

    await expect(
      service.listForBranch(principal([]), {}),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repo.find).not.toHaveBeenCalled();
  });

  it('stores foreground phone location for the authenticated rider in their sole branch', async () => {
    const repo = makeRiderRepo();
    repo.findOne.mockResolvedValueOnce({
      id: 'rider-1',
      authUserId: 'driver-user-1',
      branchId: 'branch-uuid-1',
      status: 'Available',
      deletedAt: null,
    } as Rider);
    const service = makeService(repo);
    const capturedAt = new Date().toISOString();

    const result = await service.updateDeliveryRiderOperationalLocation(
      driverPrincipal(['branch-uuid-1']),
      {
        latitude: 14.5995,
        longitude: 120.9842,
        accuracyM: 8.5,
        capturedAt,
      },
    );

    expect(repo.findOne).toHaveBeenCalledWith({
      where: expect.objectContaining({
        authUserId: 'driver-user-1',
        branchId: 'branch-uuid-1',
      }),
    });
    const [criteria, patch] = repo.update.mock.calls[0];
    expect(criteria).toEqual(expect.objectContaining({
      id: 'rider-1',
      branchId: 'branch-uuid-1',
      status: 'Available',
    }));
    expect(patch).toEqual(expect.objectContaining({
      operationalLatitude: 14.5995,
      operationalLongitude: 120.9842,
      operationalAccuracyM: 8.5,
      operationalLocationCapturedAt: new Date(capturedAt),
    }));
    expect(result.recorded).toBe(true);
    expect(result.receivedAt).toBeInstanceOf(Date);
  });

  it('rejects phone location while the rider is Offline', async () => {
    const repo = makeRiderRepo();
    repo.findOne.mockResolvedValueOnce({
      id: 'rider-1',
      authUserId: 'driver-user-1',
      branchId: 'branch-uuid-1',
      status: 'Offline',
      deletedAt: null,
    } as Rider);
    const service = makeService(repo);

    await expect(service.updateDeliveryRiderOperationalLocation(
      driverPrincipal(['branch-uuid-1']),
      {
        latitude: 14.5995,
        longitude: 120.9842,
        accuracyM: 8.5,
        capturedAt: new Date().toISOString(),
      },
    )).rejects.toBeInstanceOf(ConflictException);
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('clears dispatch-facing phone location when the rider goes Offline', async () => {
    const repo = makeRiderRepo();
    repo.findOne.mockResolvedValueOnce({
      id: 'rider-1',
      authUserId: 'driver-user-1',
      branchId: 'branch-uuid-1',
      status: 'Available',
      deletedAt: null,
    } as Rider);
    const service = makeService(repo);

    await service.setDeliveryRiderAvailability(
      driverPrincipal(['branch-uuid-1']),
      false,
    );

    const [, patch] = repo.update.mock.calls[0];
    expect(patch).toEqual(expect.objectContaining({
      status: 'Offline',
      operationalLatitude: null,
      operationalLongitude: null,
      operationalLocationCapturedAt: null,
      operationalLocationReceivedAt: null,
    }));
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

  it('registers a vehicle in the JWT-derived branch and starts PMS tracking at its odometer', async () => {
    const riderRepo = makeRiderRepo();
    riderRepo.findOne.mockResolvedValueOnce({
      id: '550e8400-e29b-41d4-a716-446655440000',
      branchId: 'branch-uuid-1',
      deletedAt: null,
    } as Rider);
    const vehicleRepo = makeVehicleRepo();
    vehicleRepo.findOne
      .mockResolvedValueOnce(null) // plate is free
      .mockResolvedValueOnce(null); // rider is not assigned elsewhere
    const traccar = makeTraccar();
    const service = makeService(
      riderRepo,
      vehicleRepo,
      makeLogRepo(),
      makeBranchRepo(),
      traccar,
    );

    const registered = await service.registerVehicle(principal(['branch-uuid-1']), {
      plateNumber: '  abc-1234  ',
      initialOdometerKm: 4250,
      assignedRiderId: '550e8400-e29b-41d4-a716-446655440000',
    });

    expect(vehicleRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        branchId: 'branch-uuid-1',
        plateNumber: 'ABC-1234',
        vehicleType: 'motorcycle',
        assignedRiderId: '550e8400-e29b-41d4-a716-446655440000',
        status: 'active',
        hardwareUniqueId: null,
        traccarProvisioningStatus: 'unconfigured',
        currentOdometerKm: 4250,
        lastPmsOdometerKm: 4250,
      }),
    );
    expect(traccar.provisionDevice).not.toHaveBeenCalled();
    expect(registered.traccarDeviceId).toBeNull();
    expect(registered.traccarProvisioningStatus).toBe('unconfigured');
    expect(registered.traccarProvisionedAt).toBeNull();
    expect(registered.id).toBe('vehicle-new');
  });

  it('connects a SinoTrack ST-901 to an existing branch-scoped vehicle', async () => {
    const vehicleRepo = makeVehicleRepo({
      hardwareUniqueId: null,
      traccarDeviceId: null,
      traccarProvisioningStatus: 'unconfigured',
      traccarProvisionedAt: null,
    });
    vehicleRepo.findOne
      .mockResolvedValueOnce(vehicleRepo.__vehicle) // branch-scoped vehicle
      .mockResolvedValueOnce(null); // hardware identifier is free
    const traccar = makeTraccar();
    const service = makeService(
      makeRiderRepo(),
      vehicleRepo,
      makeLogRepo(),
      makeBranchRepo(),
      traccar,
    );

    const connected = await service.connectVehicleGps(
      principal(['branch-uuid-1']),
      'vehicle-1',
      {
        hardwareUniqueId: '867530900000001',
      },
    );

    expect(vehicleRepo.findOne.mock.calls[0][0]?.where).toEqual(
      expect.objectContaining({ id: 'vehicle-1' }),
    );
    expect(vehicleRepo.findOne.mock.calls[1][0]?.where).toEqual({
      branchId: 'branch-uuid-1',
      hardwareUniqueId: '867530900000001',
    });
    expect(traccar.provisionDevice).toHaveBeenCalledWith(
      'NBH-1234',
      '867530900000001',
    );
    expect(connected.traccarProvisioningStatus).toBe('provisioned');
    expect(connected.traccarDeviceId).toBe('77');
  });

  it('rejects a hardware identifier already connected to another branch vehicle', async () => {
    const vehicleRepo = makeVehicleRepo({
      hardwareUniqueId: null,
      traccarDeviceId: null,
      traccarProvisioningStatus: 'unconfigured',
      traccarProvisionedAt: null,
    });
    vehicleRepo.findOne
      .mockResolvedValueOnce(vehicleRepo.__vehicle)
      .mockResolvedValueOnce({ ...vehicleRepo.__vehicle, id: 'vehicle-2' });
    const traccar = makeTraccar();
    const service = makeService(
      makeRiderRepo(),
      vehicleRepo,
      makeLogRepo(),
      makeBranchRepo(),
      traccar,
    );

    await expect(
      service.connectVehicleGps(principal(['branch-uuid-1']), 'vehicle-1', {
        hardwareUniqueId: '867530900000001',
      }),
    ).rejects.toThrow('GPS hardware identifier is already registered');

    expect(vehicleRepo.save).not.toHaveBeenCalled();
    expect(traccar.provisionDevice).not.toHaveBeenCalled();
  });

  it('keeps the vehicle but marks connection failed when Traccar is unavailable', async () => {
    const vehicleRepo = makeVehicleRepo({
      hardwareUniqueId: null,
      traccarDeviceId: null,
      traccarProvisioningStatus: 'unconfigured',
      traccarProvisionedAt: null,
    });
    vehicleRepo.findOne
      .mockResolvedValueOnce(vehicleRepo.__vehicle)
      .mockResolvedValueOnce(null);
    const traccar = makeTraccar();
    traccar.provisionDevice.mockRejectedValueOnce(new Error('Traccar is unreachable'));
    const service = makeService(
      makeRiderRepo(),
      vehicleRepo,
      makeLogRepo(),
      makeBranchRepo(),
      traccar,
    );

    const connected = await service.connectVehicleGps(
      principal(['branch-uuid-1']),
      'vehicle-1',
      { hardwareUniqueId: '867530900000002' },
    );

    expect(connected.traccarProvisioningStatus).toBe('failed');
    expect(connected.traccarProvisioningError).toBe('Traccar is unreachable');
    expect(connected.traccarDeviceId).toBeNull();
    expect(vehicleRepo.save).toHaveBeenCalledTimes(2);
  });

  it('retries provisioning for a failed vehicle using its branch-scoped CRM record', async () => {
    const vehicleRepo = makeVehicleRepo({
      traccarDeviceId: null,
      traccarProvisioningStatus: 'failed',
      traccarProvisioningError: 'Traccar is unreachable',
      traccarProvisionedAt: null,
    });
    const traccar = makeTraccar();
    const service = makeService(
      makeRiderRepo(),
      vehicleRepo,
      makeLogRepo(),
      makeBranchRepo(),
      traccar,
    );

    const retried = await service.retryVehicleProvisioning(
      principal(['branch-uuid-1']),
      'vehicle-1',
    );

    const retryWhere = vehicleRepo.findOne.mock.calls[0][0]?.where as Record<
      string,
      unknown
    >;
    expect(retryWhere.id).toBe('vehicle-1');
    expect(retryWhere).toHaveProperty('branchId');
    expect(traccar.provisionDevice).toHaveBeenCalledWith(
      'NBH-1234',
      '867530900000001',
    );
    expect(retried.traccarProvisioningStatus).toBe('provisioned');
    expect(vehicleRepo.save).toHaveBeenCalledTimes(2);
  });

  it('rejects registration when the plate already exists in the manager branch', async () => {
    const vehicleRepo = makeVehicleRepo();
    const service = makeService(makeRiderRepo(), vehicleRepo);

    await expect(
      service.registerVehicle(principal(['branch-uuid-1']), {
        plateNumber: 'NBH-1234',
        initialOdometerKm: 0,
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(vehicleRepo.save).not.toHaveBeenCalled();
  });

  it('rejects registration when a rider is outside the manager branch', async () => {
    const riderRepo = makeRiderRepo();
    const vehicleRepo = makeVehicleRepo();
    vehicleRepo.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    const service = makeService(riderRepo, vehicleRepo);

    await expect(
      service.registerVehicle(principal(['branch-uuid-1']), {
        plateNumber: 'ABC-1234',
        initialOdometerKm: 0,
        assignedRiderId: '550e8400-e29b-41d4-a716-446655440000',
      }),
    ).rejects.toThrow('Assigned Delivery Rider was not found in this branch');

    expect(vehicleRepo.save).not.toHaveBeenCalled();
  });

  it('fails closed instead of choosing a client branch for vehicle registration', async () => {
    const vehicleRepo = makeVehicleRepo();
    const service = makeService(makeRiderRepo(), vehicleRepo);

    await expect(
      service.registerVehicle(principal(['branch-uuid-1', 'branch-uuid-2']), {
        plateNumber: 'ABC-1234',
        initialOdometerKm: 0,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(vehicleRepo.save).not.toHaveBeenCalled();
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
