import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';
import { FindOperator, Repository } from 'typeorm';
import { Principal } from '../auth/principal';
import { Branch } from '../branches/branch.entity';
import { CimService } from '../cim/cim.service';
import { Customer } from '../cim/customer.entity';
import { FleetService } from '../fleet/fleet.service';
import { Rider } from '../fleet/rider.entity';
import { LoyaltyService } from '../loyalty/loyalty.service';
import { PricesService } from '../prices/prices.service';
import { PayMongoService } from './paymongo.service';
import { CreateServiceRequestDto } from './dto/create-service-request.dto';
import { ServiceRequest } from './service-request.entity';
import { ServiceRequestStatusHistory } from './service-request-status-history.entity';
import { SlaConfiguration } from './sla-configuration.entity';
import { ServiceRequestsService } from './service-requests.service';

/**
 * Unit coverage for the SRD intake/queue/dispatch service. The focus is branch
 * scoping, server-owned fields, and the dispatch race guard — the panel-defense
 * points (AGENTS.md §5, §8.2) — so the repository and Fleet service are faked;
 * no database is touched.
 */
describe('ServiceRequestsService', () => {
  // Minimal fake standing in for the TypeORM repository. `create` echoes its
  // input (as the real one does); `save`/`find`/`findOne` are spies; the
  // dispatch path uses a chainable query builder whose `execute` reports how
  // many rows the conditional UPDATE touched.
  const makeRepo = (updateAffected = 1) => {
    const execute = jest.fn(() => Promise.resolve({ affected: updateAffected }));
    const qb = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute,
    };
    return {
      repo: {
        create: jest.fn((v: Partial<ServiceRequest>) => v as ServiceRequest),
        save: jest.fn((v: ServiceRequest) => Promise.resolve(v)),
        find: jest.fn(() => Promise.resolve([])),
        findOne: jest.fn(() => Promise.resolve(null)),
        createQueryBuilder: jest.fn(() => qb),
      } as unknown as jest.Mocked<Repository<ServiceRequest>>,
      qb,
    };
  };

  // Fake Fleet service: `findAssignableRider` returns the NEW rider being
  // assigned (or null when not assignable); `findInBranch` is the
  // status-agnostic lookup reassign() uses to name the CURRENT rider (who is
  // 'On Delivery', not 'Available') — defaults to the same rider so existing
  // dispatch/deliver tests (which only care about one rider) are unaffected;
  // `markOnDelivery` / `markAvailable` are spies.
  const makeFleet = (assignableRider: Rider | null, currentRider: Rider | null = assignableRider) =>
    ({
      findAssignableRider: jest.fn(() => Promise.resolve(assignableRider)),
      findInBranch: jest.fn(() => Promise.resolve(currentRider)),
      markOnDelivery: jest.fn(() => Promise.resolve()),
      markAvailable: jest.fn(() => Promise.resolve()),
    }) as unknown as jest.Mocked<FleetService>;

  // Fake SLA-configuration repo: `find` returns no rows by default (no
  // thresholds configured), so pre-existing dispatch/deliver/edit/cancel tests
  // are unaffected — computeBreach/computeAtRisk both fail quiet with nothing
  // configured. Tests targeting BM-US-02 pass real rows.
  const makeSlaConfig = (rows: Partial<SlaConfiguration>[] = []) =>
    ({
      find: jest.fn(() => Promise.resolve(rows as SlaConfiguration[])),
    }) as unknown as jest.Mocked<Repository<SlaConfiguration>>;

  // Fake CIM service: `findInBranch` returns a customer (in-branch link valid) or
  // null (unknown / soft-deleted / other branch → the create rejects with 400).
  const makeCim = (customer: Customer | null) =>
    ({
      findInBranch: jest.fn(() => Promise.resolve(customer)),
      upsertSelfRegisteredInBranch: jest.fn(() =>
        Promise.resolve(
          customer ??
            ({ id: 'mobile-cust-1', branchId: 'branch-uuid-1' } as Customer),
        ),
      ),
      profileIdsForAuthUser: jest.fn(() =>
        Promise.resolve(customer ? [customer.id] : []),
      ),
    }) as unknown as jest.Mocked<CimService>;

  const makeBranches = (branch: Branch | null = null) =>
    ({
      findOne: jest.fn(() => Promise.resolve(branch)),
    }) as unknown as jest.Mocked<Repository<Branch>>;

  // Fake status-history repo: `create` echoes its input (as the real one does),
  // `save` is a spy. Edit/cancel tests inspect these to assert an audit row was
  // written with the right from/to status, actor, and note.
  const makeHistory = () =>
    ({
      create: jest.fn((v: Partial<ServiceRequestStatusHistory>) => v),
      save: jest.fn((v: ServiceRequestStatusHistory) => Promise.resolve(v)),
    }) as unknown as jest.Mocked<Repository<ServiceRequestStatusHistory>>;

  const makePrices = () =>
    ({
      findByCylinderSize: jest.fn((cylinderSize: string) =>
        Promise.resolve({ cylinderSize, unitPrice: 650 }),
      ),
    }) as unknown as jest.Mocked<PricesService>;

  const makePayMongo = () =>
    ({
      expireCheckout: jest.fn(() => Promise.resolve()),
    }) as unknown as jest.Mocked<PayMongoService>;

  const makeLoyalty = () =>
    ({
      recordDeliveredPurchase: jest.fn(() => Promise.resolve()),
    }) as unknown as jest.Mocked<LoyaltyService>;

  // sla defaults to "no thresholds configured" so every pre-existing call site
  // (which only ever passed the first four args) is unaffected — appended at
  // the END of this helper's own params, even though the real constructor
  // takes it 3rd, precisely so no existing call site needs to change.
  const makeService = (
    repo: jest.Mocked<Repository<ServiceRequest>>,
    history: jest.Mocked<Repository<ServiceRequestStatusHistory>>,
    fleet: jest.Mocked<FleetService>,
    cim: jest.Mocked<CimService>,
    sla: jest.Mocked<Repository<SlaConfiguration>> = makeSlaConfig(),
    branches: jest.Mocked<Repository<Branch>> = makeBranches(),
    loyalty: jest.Mocked<LoyaltyService> = makeLoyalty(),
  ) => new ServiceRequestsService(
    repo,
    branches,
    history,
    sla,
    fleet,
    cim,
    makePrices(),
    makePayMongo(),
    loyalty,
  );

  const inBranchCustomer = (): Customer =>
    ({ id: 'cust-1', branchId: 'branch-uuid-1' }) as Customer;

  const principal = (branchIds: string[]): Principal => ({
    userId: 'user-1',
    role: 'branch-manager',
    branches: ['Alpha'],
    branchIds,
  });

  const pendingSr = (): ServiceRequest =>
    ({
      id: 'sr-1',
      branchId: 'branch-uuid-1',
      status: 'Pending',
      paymentMethod: 'Cash on Delivery',
      paymentStatus: 'Unpaid',
      paymentPaidAt: null,
      dispatchedAt: null,
      riderId: null,
    }) as ServiceRequest;

  // A request currently out for delivery: dispatched, rider assigned, not yet
  // delivered. in_transit_at stays null (En Route leg is deferred, AGENTS.md §8).
  const outForDeliverySr = (): ServiceRequest =>
    ({
      id: 'sr-1',
      branchId: 'branch-uuid-1',
      status: 'Dispatched',
      paymentMethod: 'Cash on Delivery',
      paymentStatus: 'Unpaid',
      paymentPaidAt: null,
      dispatchedAt: new Date(),
      inTransitAt: null,
      deliveredAt: null,
      riderId: 'rider-1',
    }) as ServiceRequest;

  const availableRider = (): Rider =>
    ({ id: 'rider-1', branchId: 'branch-uuid-1', status: 'Available' }) as Rider;

  // For reassign() tests: the rider CURRENTLY assigned (On Delivery, matches
  // outForDeliverySr's riderId) and a DIFFERENT rider being reassigned to.
  const currentAssignedRider = (): Rider =>
    ({ id: 'rider-1', branchId: 'branch-uuid-1', status: 'On Delivery', name: 'Current Rider' }) as Rider;
  const newAssignableRider = (): Rider =>
    ({ id: 'rider-2', branchId: 'branch-uuid-1', status: 'Available', name: 'New Rider' }) as Rider;

  const dto: CreateServiceRequestDto = {
    customerName: '  Juan Dela Cruz ',
    customerContact: '09171234567',
    deliveryAddress: '123 Rizal St',
    cylinderSize: '11kg',
    quantity: 2,
  };

  it('files a request under the caller branch with server-owned fields', async () => {
    const { repo } = makeRepo();
    const service = makeService(repo, makeHistory(), makeFleet(null), makeCim(null));

    const result = await service.create(principal(['branch-uuid-1']), dto);

    expect(result.branchId).toBe('branch-uuid-1');
    expect(result.orderSource).toBe('Walk-in/Phone');
    expect(result.status).toBe('Pending');
    expect(result.requestedAt).toBeInstanceOf(Date);
    // Trailing SLA timestamps are for later slices — null at intake.
    expect(result.dispatchedAt).toBeNull();
    expect(result.deliveredAt).toBeNull();
    // Free-text inputs are trimmed.
    expect(result.customerName).toBe('Juan Dela Cruz');
    // Price comes from the shared catalog and is copied onto this order so a
    // later catalog update cannot change its historical amount.
    expect(result.unitPrice).toBe(650);
    expect(result.totalAmount).toBe(1300);
    // No customerId on this dto → the order is filed with no linked profile
    // (walk-in intake is unchanged, story BM-005).
    expect(result.customerId).toBeNull();
    expect(repo.save).toHaveBeenCalledTimes(1);
  });

  it('links a same-branch customer when customerId is supplied', async () => {
    const { repo } = makeRepo();
    const cim = makeCim(inBranchCustomer());
    const service = makeService(repo, makeHistory(), makeFleet(null), cim);

    const result = await service.create(principal(['branch-uuid-1']), {
      ...dto,
      customerId: 'cust-1',
    });

    // The customer is validated against the request's own branch, then its id is
    // stored on the order.
    expect(cim.findInBranch).toHaveBeenCalledWith('cust-1', 'branch-uuid-1');
    expect(result.customerId).toBe('cust-1');
    expect(repo.save).toHaveBeenCalledTimes(1);
  });

  it('400s when the linked customer is not in the request branch', async () => {
    const { repo } = makeRepo();
    // findInBranch returns null for an unknown / soft-deleted / other-branch id.
    const cim = makeCim(null);
    const service = makeService(repo, makeHistory(), makeFleet(null), cim);

    await expect(
      service.create(principal(['branch-uuid-1']), {
        ...dto,
        customerId: 'cust-other-branch',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    // Rejected before persisting the order.
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('upserts a mobile customer into branch CIM and links the order to that profile', async () => {
    const { repo } = makeRepo();
    const customer = {
      id: 'mobile-cust-1',
      branchId: 'branch-uuid-1',
      authUserId: 'auth-user-1',
    } as Customer;
    const cim = makeCim(customer);
    const branches = makeBranches({
      id: 'branch-uuid-1',
      status: 'active',
    } as Branch);
    const service = makeService(
      repo,
      makeHistory(),
      makeFleet(null),
      cim,
      makeSlaConfig(),
      branches,
    );
    const mobilePrincipal: Principal = {
      userId: 'auth-user-1',
      role: 'customer',
      accountType: 'household',
      branches: [],
      branchIds: [],
    };

    const result = await service.createForCustomer(mobilePrincipal, {
      branchId: 'branch-uuid-1',
      customerName: 'Shoti Go',
      customerContact: '+639399168168',
      deliveryAddress: 'Las Pinas',
      cylinderSize: '2.7kg',
      quantity: 1,
      paymentMethod: 'Cash on Delivery',
    });

    expect(cim.upsertSelfRegisteredInBranch).toHaveBeenCalledWith({
      authUserId: 'auth-user-1',
      branchId: 'branch-uuid-1',
      name: 'Shoti Go',
      contactNumber: '+639399168168',
      deliveryAddress: 'Las Pinas',
      accountType: 'household',
    });
    expect(result.customerId).toBe('mobile-cust-1');
    expect(result.orderSource).toBe('Mobile App');
    expect(repo.save).toHaveBeenCalledTimes(1);
  });

  it('loads customer history through owned CIM profile ids with a legacy fallback', async () => {
    const { repo } = makeRepo();
    const cim = makeCim(inBranchCustomer());
    const service = makeService(repo, makeHistory(), makeFleet(null), cim);
    const mobilePrincipal: Principal = {
      userId: 'auth-user-1',
      role: 'customer',
      branches: [],
      branchIds: [],
    };

    await service.listForCustomer(mobilePrincipal);

    expect(cim.profileIdsForAuthUser).toHaveBeenCalledWith('auth-user-1');
    const where = repo.find.mock.calls[0][0]?.where as {
      customerId: FindOperator<string>;
    };
    expect(where.customerId.value).toEqual(['auth-user-1', 'cust-1']);
  });

  it('fails closed when the caller has no active branch', async () => {
    const { repo } = makeRepo();
    const service = makeService(repo, makeHistory(), makeFleet(null), makeCim(null));

    await expect(service.create(principal([]), dto)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.list(principal([]))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.findById(principal([]), 'x')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      service.dispatch(principal([]), 'sr-1', { riderId: 'rider-1' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.deliver(principal([]), 'sr-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      service.edit(principal([]), 'sr-1', { deliveryAddress: '1 New St' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.cancel(principal([]), 'sr-1', { reason: 'no longer needed' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    // Nothing should reach the data layer once scoping fails.
    expect(repo.save).not.toHaveBeenCalled();
    expect(repo.find).not.toHaveBeenCalled();
  });

  it('scopes the queue to the caller branches, newest first', async () => {
    const { repo } = makeRepo();
    const service = makeService(repo, makeHistory(), makeFleet(null), makeCim(null));

    await service.list(principal(['branch-uuid-1', 'branch-uuid-2']));

    const where = repo.find.mock.calls[0][0]?.where as Record<string, unknown>;
    // branchId is filtered via In(...) and soft-deleted rows excluded.
    expect(where).toHaveProperty('branchId');
    expect(where).toHaveProperty('deletedAt');
    expect(repo.find.mock.calls[0][0]?.order).toEqual({ requestedAt: 'DESC' });
  });

  it('returns 404 for an id outside the caller scope or not found', async () => {
    const { repo } = makeRepo();
    const service = makeService(repo, makeHistory(), makeFleet(null), makeCim(null));

    await expect(
      service.findById(principal(['branch-uuid-1']), 'missing'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  describe('dispatch', () => {
    it('assigns the rider, stamps dispatch, and flips the rider to On Delivery', async () => {
      const { repo, qb } = makeRepo(1);
      repo.findOne = jest.fn(() => Promise.resolve(pendingSr())) as never;
      const fleet = makeFleet(availableRider());
      const service = makeService(repo, makeHistory(), fleet, makeCim(null));

      const result = await service.dispatch(principal(['branch-uuid-1']), 'sr-1', {
        riderId: 'rider-1',
      });

      // The four fields the dispatch commits.
      expect(result.riderId).toBe('rider-1');
      expect(result.dispatchedAt).toBeInstanceOf(Date);
      expect(result.status).toBe('Dispatched');
      expect(result.updatedAt).toBeInstanceOf(Date);
      // Committed via a conditional UPDATE (the race guard), not a plain save.
      expect(qb.execute).toHaveBeenCalledTimes(1);
      // Rider drops out of the Available list.
      expect(fleet.markOnDelivery).toHaveBeenCalledWith('rider-1');
    });

    it('409s when the request is already dispatched (status not Pending)', async () => {
      const { repo, qb } = makeRepo();
      const dispatched = { ...pendingSr(), status: 'Dispatched' } as ServiceRequest;
      repo.findOne = jest.fn(() => Promise.resolve(dispatched)) as never;
      const fleet = makeFleet(availableRider());
      const service = makeService(repo, makeHistory(), fleet, makeCim(null));

      await expect(
        service.dispatch(principal(['branch-uuid-1']), 'sr-1', { riderId: 'rider-1' }),
      ).rejects.toBeInstanceOf(ConflictException);
      // Bailed before validating a rider or touching the data layer.
      expect(fleet.findAssignableRider).not.toHaveBeenCalled();
      expect(qb.execute).not.toHaveBeenCalled();
    });

    it('409s an unpaid PayMongo request before assigning a rider', async () => {
      const { repo, qb } = makeRepo();
      repo.findOne = jest.fn(() => Promise.resolve({
        ...pendingSr(),
        paymentMethod: 'PayMongo',
        paymentStatus: 'Pending',
      } as ServiceRequest)) as never;
      const fleet = makeFleet(availableRider());
      const service = makeService(repo, makeHistory(), fleet, makeCim(null));

      await expect(
        service.dispatch(principal(['branch-uuid-1']), 'sr-1', { riderId: 'rider-1' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(fleet.findAssignableRider).not.toHaveBeenCalled();
      expect(qb.execute).not.toHaveBeenCalled();
    });

    it('409s when a concurrent dispatch won the race (0 rows affected)', async () => {
      // Row still looks Pending on load, but the conditional UPDATE touches 0
      // rows because another dispatch committed first (AGENTS.md §8.2).
      const { repo, qb } = makeRepo(0);
      repo.findOne = jest.fn(() => Promise.resolve(pendingSr())) as never;
      const fleet = makeFleet(availableRider());
      const service = makeService(repo, makeHistory(), fleet, makeCim(null));

      await expect(
        service.dispatch(principal(['branch-uuid-1']), 'sr-1', { riderId: 'rider-1' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(qb.execute).toHaveBeenCalledTimes(1);
      // The loser must NOT flip the rider — that rider is on the winner's order.
      expect(fleet.markOnDelivery).not.toHaveBeenCalled();
    });

    it('400s when the rider is not assignable (wrong branch, soft-deleted, or not Available)', async () => {
      const { repo, qb } = makeRepo();
      repo.findOne = jest.fn(() => Promise.resolve(pendingSr())) as never;
      // Fleet lookup returns null for any of: unknown, soft-deleted, wrong
      // branch, or not-Available rider.
      const fleet = makeFleet(null);
      const service = makeService(repo, makeHistory(), fleet, makeCim(null));

      await expect(
        service.dispatch(principal(['branch-uuid-1']), 'sr-1', { riderId: 'rider-x' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      // No commit and no rider flip when validation fails.
      expect(qb.execute).not.toHaveBeenCalled();
      expect(fleet.markOnDelivery).not.toHaveBeenCalled();
    });

    it('404s for a request outside the caller scope or not found', async () => {
      const { repo } = makeRepo();
      // findOne already returns null by default (out of scope / missing).
      const fleet = makeFleet(availableRider());
      const service = makeService(repo, makeHistory(), fleet, makeCim(null));

      await expect(
        service.dispatch(principal(['branch-uuid-1']), 'missing', { riderId: 'rider-1' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(fleet.findAssignableRider).not.toHaveBeenCalled();
    });
  });

  describe('deliver', () => {
    it('stamps delivery, closes the chain, and returns the rider to Available', async () => {
      const { repo, qb } = makeRepo(1);
      repo.findOne = jest.fn(() => Promise.resolve(outForDeliverySr())) as never;
      const fleet = makeFleet(null);
      const service = makeService(repo, makeHistory(), fleet, makeCim(null));

      const result = await service.deliver(principal(['branch-uuid-1']), 'sr-1');

      // The fields the deliver commits.
      expect(result.deliveredAt).toBeInstanceOf(Date);
      expect(result.status).toBe('Delivered');
      expect(result.updatedAt).toBeInstanceOf(Date);
      expect(result.paymentStatus).toBe('Paid');
      expect(result.paymentPaidAt).toBeInstanceOf(Date);
      // in_transit_at is not backfilled — the En Route leg is deferred (§8).
      expect(result.inTransitAt).toBeNull();
      // Committed via the conditional UPDATE (the race guard), not a plain save.
      expect(qb.execute).toHaveBeenCalledTimes(1);
      expect(qb.set).toHaveBeenCalledWith(
        expect.objectContaining({ paymentStatus: 'Paid' }),
      );
      // The assigned rider goes back on the roster.
      expect(fleet.markAvailable).toHaveBeenCalledWith('rider-1');
    });

    it('409s when the request is not out for delivery (0 rows affected)', async () => {
      // Covers still-Pending, already-Delivered, and Cancelled: the conditional
      // UPDATE (dispatched_at IS NOT NULL AND delivered_at IS NULL) touches 0
      // rows, and a concurrent deliver that already won hits the same guard.
      const { repo, qb } = makeRepo(0);
      repo.findOne = jest.fn(() => Promise.resolve(outForDeliverySr())) as never;
      const fleet = makeFleet(null);
      const service = makeService(repo, makeHistory(), fleet, makeCim(null));

      await expect(
        service.deliver(principal(['branch-uuid-1']), 'sr-1'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(qb.execute).toHaveBeenCalledTimes(1);
      // The loser must NOT touch the rider — nothing was committed.
      expect(fleet.markAvailable).not.toHaveBeenCalled();
    });

    it('repairs a missing loyalty entry when a committed delivery is retried', async () => {
      const { repo, qb } = makeRepo();
      const delivered = {
        ...outForDeliverySr(),
        status: 'Delivered',
        deliveredAt: new Date('2026-08-21T00:00:00.000Z'),
        customerId: 'customer-1',
        cylinderSize: '11kg',
        quantity: 2,
      } as ServiceRequest;
      repo.findOne = jest.fn(() => Promise.resolve(delivered)) as never;
      const loyalty = makeLoyalty();
      const service = makeService(
        repo,
        makeHistory(),
        makeFleet(null),
        makeCim(null),
        makeSlaConfig(),
        makeBranches(),
        loyalty,
      );

      await expect(
        service.deliver(principal(['branch-uuid-1']), 'sr-1'),
      ).resolves.toBe(delivered);
      expect(loyalty.recordDeliveredPurchase).toHaveBeenCalledWith(
        'customer-1',
        'branch-uuid-1',
        'sr-1',
        '11kg',
        2,
      );
      expect(qb.execute).not.toHaveBeenCalled();
    });

    it('404s for a request outside the caller scope or not found', async () => {
      const { repo, qb } = makeRepo();
      // findOne returns null by default (out of scope / missing).
      const fleet = makeFleet(null);
      const service = makeService(repo, makeHistory(), fleet, makeCim(null));

      await expect(
        service.deliver(principal(['branch-uuid-1']), 'missing'),
      ).rejects.toBeInstanceOf(NotFoundException);
      // Bailed before committing or touching the fleet.
      expect(qb.execute).not.toHaveBeenCalled();
      expect(fleet.markAvailable).not.toHaveBeenCalled();
    });
  });

  // A pre-dispatch request carrying the mutable order fields an edit can touch.
  const editablePendingSr = (): ServiceRequest =>
    ({
      id: 'sr-1',
      branchId: 'branch-uuid-1',
      status: 'Pending',
      dispatchedAt: null,
      deletedAt: null,
      riderId: null,
      deliveryAddress: '123 Rizal St',
      cylinderSize: '11kg',
      quantity: 2,
      specialInstructions: null,
    }) as ServiceRequest;

  describe('edit', () => {
    it('updates the changed fields and writes a history row with an old→new note', async () => {
      const { repo, qb } = makeRepo(1);
      repo.findOne = jest.fn(() => Promise.resolve(editablePendingSr())) as never;
      const history = makeHistory();
      const service = new ServiceRequestsService(
        repo,
        makeBranches(),
        history,
        makeSlaConfig(),
        makeFleet(null),
        makeCim(null),
        makePrices(),
        makePayMongo(),
        makeLoyalty(),
      );

      const result = await service.edit(principal(['branch-uuid-1']), 'sr-1', {
        deliveryAddress: '456 Bonifacio Ave',
        quantity: 3,
      });

      // The committed fields are reflected back; untouched fields are unchanged.
      expect(result.deliveryAddress).toBe('456 Bonifacio Ave');
      expect(result.quantity).toBe(3);
      expect(result.cylinderSize).toBe('11kg');
      // An edit is not a lifecycle transition — the request stays Pending.
      expect(result.status).toBe('Pending');
      expect(result.updatedAt).toBeInstanceOf(Date);
      // Committed via the conditional UPDATE (the pre-dispatch race guard).
      expect(qb.execute).toHaveBeenCalledTimes(1);
      // Exactly one audit row, capturing the old→new diff of only what changed.
      expect(history.save).toHaveBeenCalledTimes(1);
      const saved = history.create.mock.calls[0][0] as ServiceRequestStatusHistory;
      expect(saved.fromStatus).toBe('Pending');
      expect(saved.toStatus).toBe('Pending');
      expect(saved.changedBy).toBe('user-1');
      expect(saved.branchId).toBe('branch-uuid-1');
      expect(saved.note).toContain('delivery_address');
      expect(saved.note).toContain('"123 Rizal St" → "456 Bonifacio Ave"');
      expect(saved.note).toContain('quantity 2 → 3');
      // Untouched fields are absent from the note.
      expect(saved.note).not.toContain('cylinder_size');
    });

    it('409s when already dispatched (0 rows affected) and writes no history', async () => {
      // Row looks Pending on load, but the guarded UPDATE touches 0 rows because
      // a concurrent dispatch committed first — the write-time check (BM-034/037).
      const { repo, qb } = makeRepo(0);
      repo.findOne = jest.fn(() => Promise.resolve(editablePendingSr())) as never;
      const history = makeHistory();
      const service = new ServiceRequestsService(
        repo,
        makeBranches(),
        history,
        makeSlaConfig(),
        makeFleet(null),
        makeCim(null),
        makePrices(),
        makePayMongo(),
        makeLoyalty(),
      );

      await expect(
        service.edit(principal(['branch-uuid-1']), 'sr-1', {
          deliveryAddress: '456 Bonifacio Ave',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(qb.execute).toHaveBeenCalledTimes(1);
      // No audit row when the authoritative commit failed.
      expect(history.save).not.toHaveBeenCalled();
    });

    it('404s for a request outside the caller scope or not found', async () => {
      const { repo, qb } = makeRepo();
      // findOne returns null by default (out of scope / missing).
      const history = makeHistory();
      const service = new ServiceRequestsService(
        repo,
        makeBranches(),
        history,
        makeSlaConfig(),
        makeFleet(null),
        makeCim(null),
        makePrices(),
        makePayMongo(),
        makeLoyalty(),
      );

      await expect(
        service.edit(principal(['branch-uuid-1']), 'missing', {
          deliveryAddress: '456 Bonifacio Ave',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      // Bailed before committing or auditing.
      expect(qb.execute).not.toHaveBeenCalled();
      expect(history.save).not.toHaveBeenCalled();
    });
  });

  describe('cancel', () => {
    it('sets status Cancelled and logs the reason to history', async () => {
      const { repo, qb } = makeRepo(1);
      repo.findOne = jest.fn(() => Promise.resolve(editablePendingSr())) as never;
      const history = makeHistory();
      const service = new ServiceRequestsService(
        repo,
        makeBranches(),
        history,
        makeSlaConfig(),
        makeFleet(null),
        makeCim(null),
        makePrices(),
        makePayMongo(),
        makeLoyalty(),
      );

      const result = await service.cancel(principal(['branch-uuid-1']), 'sr-1', {
        reason: 'Customer changed their mind',
      });

      expect(result.status).toBe('Cancelled');
      expect(result.updatedAt).toBeInstanceOf(Date);
      // No SLA timestamp is stamped — a cancelled order voids the clock.
      expect(result.dispatchedAt).toBeNull();
      // Committed via the conditional UPDATE (the pre-dispatch race guard).
      expect(qb.execute).toHaveBeenCalledTimes(1);
      // The transition is audited with the reason recorded verbatim.
      expect(history.save).toHaveBeenCalledTimes(1);
      const saved = history.create.mock.calls[0][0] as ServiceRequestStatusHistory;
      expect(saved.fromStatus).toBe('Pending');
      expect(saved.toStatus).toBe('Cancelled');
      expect(saved.changedBy).toBe('user-1');
      expect(saved.note).toBe('Customer changed their mind');
    });

    it('blocks cancellation after PayMongo payment is confirmed', async () => {
      const { repo, qb } = makeRepo();
      repo.findOne = jest.fn(() => Promise.resolve({
        ...editablePendingSr(),
        paymentMethod: 'PayMongo',
        paymentStatus: 'Paid',
      } as ServiceRequest)) as never;
      const history = makeHistory();
      const service = makeService(repo, history, makeFleet(null), makeCim(null));

      await expect(
        service.cancel(principal(['branch-uuid-1']), 'sr-1', { reason: 'cancel' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(qb.execute).not.toHaveBeenCalled();
      expect(history.save).not.toHaveBeenCalled();
    });

    it('expires an active unpaid PayMongo checkout before cancellation', async () => {
      const { repo } = makeRepo(1);
      repo.findOne = jest.fn(() => Promise.resolve({
        ...editablePendingSr(),
        paymentMethod: 'PayMongo',
        paymentStatus: 'Pending',
        paymongoCheckoutSessionId: 'cs_test_1',
      } as ServiceRequest)) as never;
      const payMongo = makePayMongo();
      const service = new ServiceRequestsService(
        repo,
        makeBranches(),
        makeHistory(),
        makeSlaConfig(),
        makeFleet(null),
        makeCim(null),
        makePrices(),
        payMongo,
        makeLoyalty(),
      );

      await service.cancel(principal(['branch-uuid-1']), 'sr-1', { reason: 'cancel' });
      expect(payMongo.expireCheckout).toHaveBeenCalledWith('cs_test_1');
    });

    it('409s when already dispatched (0 rows affected) and writes no history', async () => {
      const { repo, qb } = makeRepo(0);
      repo.findOne = jest.fn(() => Promise.resolve(editablePendingSr())) as never;
      const history = makeHistory();
      const service = new ServiceRequestsService(
        repo,
        makeBranches(),
        history,
        makeSlaConfig(),
        makeFleet(null),
        makeCim(null),
        makePrices(),
        makePayMongo(),
        makeLoyalty(),
      );

      await expect(
        service.cancel(principal(['branch-uuid-1']), 'sr-1', {
          reason: 'too late',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(qb.execute).toHaveBeenCalledTimes(1);
      expect(history.save).not.toHaveBeenCalled();
    });

    it('404s for a request outside the caller scope or not found', async () => {
      const { repo, qb } = makeRepo();
      const history = makeHistory();
      const service = new ServiceRequestsService(
        repo,
        makeBranches(),
        history,
        makeSlaConfig(),
        makeFleet(null),
        makeCim(null),
        makePrices(),
        makePayMongo(),
        makeLoyalty(),
      );

      await expect(
        service.cancel(principal(['branch-uuid-1']), 'missing', {
          reason: 'no longer needed',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(qb.execute).not.toHaveBeenCalled();
      expect(history.save).not.toHaveBeenCalled();
    });
  });

  describe('reassign', () => {
    it('swaps the rider, updates fleet availability, and writes an audit note (BM-010)', async () => {
      const { repo, qb } = makeRepo(1);
      repo.findOne = jest.fn(() => Promise.resolve(outForDeliverySr())) as never;
      const history = makeHistory();
      const fleet = makeFleet(newAssignableRider(), currentAssignedRider());
      const service = new ServiceRequestsService(
        repo,
        makeBranches(),
        history,
        makeSlaConfig(),
        fleet,
        makeCim(null),
        makePrices(),
        makePayMongo(),
        makeLoyalty(),
      );

      const result = await service.reassign(principal(['branch-uuid-1']), 'sr-1', {
        riderId: 'rider-2',
      });

      expect(result.riderId).toBe('rider-2');
      // dispatched_at / in_transit_at are never part of the SET clause —
      // the interpretation call: reassignment never touches SLA timestamps.
      expect(qb.set).toHaveBeenCalledWith(
        expect.objectContaining({ riderId: 'rider-2' }),
      );
      const setArg = qb.set.mock.calls[0][0];
      expect(setArg).not.toHaveProperty('dispatchedAt');
      expect(setArg).not.toHaveProperty('inTransitAt');
      expect(setArg).not.toHaveProperty('status');
      expect(fleet.markAvailable).toHaveBeenCalledWith('rider-1');
      expect(fleet.markOnDelivery).toHaveBeenCalledWith('rider-2');
      expect(history.save).toHaveBeenCalledWith(
        expect.objectContaining({
          fromStatus: 'Dispatched',
          toStatus: 'Dispatched',
          note: expect.stringContaining('Current Rider'),
        }),
      );
    });

    it('400s when the request is not out for delivery', async () => {
      const { repo, qb } = makeRepo();
      repo.findOne = jest.fn(() => Promise.resolve(pendingSr())) as never;
      const service = makeService(repo, makeHistory(), makeFleet(newAssignableRider()), makeCim(null));

      await expect(
        service.reassign(principal(['branch-uuid-1']), 'sr-1', { riderId: 'rider-2' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(qb.execute).not.toHaveBeenCalled();
    });

    it('400s when reassigning to the same rider already assigned', async () => {
      const { repo } = makeRepo();
      repo.findOne = jest.fn(() => Promise.resolve(outForDeliverySr())) as never;
      const service = makeService(
        repo,
        makeHistory(),
        makeFleet(currentAssignedRider(), currentAssignedRider()),
        makeCim(null),
      );

      await expect(
        service.reassign(principal(['branch-uuid-1']), 'sr-1', { riderId: 'rider-1' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('400s when the new rider is not assignable', async () => {
      const { repo } = makeRepo();
      repo.findOne = jest.fn(() => Promise.resolve(outForDeliverySr())) as never;
      const service = makeService(
        repo,
        makeHistory(),
        makeFleet(null, currentAssignedRider()),
        makeCim(null),
      );

      await expect(
        service.reassign(principal(['branch-uuid-1']), 'sr-1', { riderId: 'rider-2' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('409s when a concurrent reassign/deliver already won the race (0 rows affected)', async () => {
      const { repo, qb } = makeRepo(0);
      repo.findOne = jest.fn(() => Promise.resolve(outForDeliverySr())) as never;
      const history = makeHistory();
      const fleet = makeFleet(newAssignableRider(), currentAssignedRider());
      const service = new ServiceRequestsService(
        repo,
        makeBranches(),
        history,
        makeSlaConfig(),
        fleet,
        makeCim(null),
        makePrices(),
        makePayMongo(),
        makeLoyalty(),
      );

      await expect(
        service.reassign(principal(['branch-uuid-1']), 'sr-1', { riderId: 'rider-2' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(qb.execute).toHaveBeenCalled();
      expect(fleet.markAvailable).not.toHaveBeenCalled();
      expect(history.save).not.toHaveBeenCalled();
    });

    it('404s for a request outside the caller scope or not found', async () => {
      const { repo } = makeRepo();
      const service = makeService(repo, makeHistory(), makeFleet(newAssignableRider()), makeCim(null));

      await expect(
        service.reassign(principal(['branch-uuid-1']), 'missing', { riderId: 'rider-2' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('logDelayReason', () => {
    it('combines the category + note into delay_reason and writes a history row (BM-011)', async () => {
      const repo = makeRepo().repo;
      repo.findOne = jest.fn(() => Promise.resolve(outForDeliverySr())) as never;
      repo.update = jest.fn(() => Promise.resolve({ affected: 1 })) as never;
      const history = makeHistory();
      const service = makeService(repo, history, makeFleet(null), makeCim(null));

      const result = await service.logDelayReason(principal(['branch-uuid-1']), 'sr-1', {
        reasonCategory: 'traffic',
        note: 'Heavy rain flooding the main road',
      });

      expect(result.delayReason).toBe('Traffic: Heavy rain flooding the main road');
      expect(repo.update).toHaveBeenCalledWith(
        { id: 'sr-1' },
        expect.objectContaining({ delayReason: 'Traffic: Heavy rain flooding the main road' }),
      );
      expect(history.save).toHaveBeenCalledWith(
        expect.objectContaining({
          note: expect.stringContaining('Traffic: Heavy rain flooding the main road'),
        }),
      );
    });

    it('omits the note when none is given', async () => {
      const repo = makeRepo().repo;
      repo.findOne = jest.fn(() => Promise.resolve(pendingSr())) as never;
      repo.update = jest.fn(() => Promise.resolve({ affected: 1 })) as never;
      const service = makeService(repo, makeHistory(), makeFleet(null), makeCim(null));

      const result = await service.logDelayReason(principal(['branch-uuid-1']), 'sr-1', {
        reasonCategory: 'weather',
      });

      expect(result.delayReason).toBe('Weather');
    });

    it('400s on a Delivered/Cancelled request', async () => {
      const repo = makeRepo().repo;
      repo.findOne = jest.fn(() =>
        Promise.resolve({ id: 'sr-1', branchId: 'branch-uuid-1', status: 'Delivered' } as ServiceRequest),
      ) as never;
      const service = makeService(repo, makeHistory(), makeFleet(null), makeCim(null));

      await expect(
        service.logDelayReason(principal(['branch-uuid-1']), 'sr-1', { reasonCategory: 'traffic' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('404s for a request outside the caller scope or not found', async () => {
      const repo = makeRepo().repo;
      const service = makeService(repo, makeHistory(), makeFleet(null), makeCim(null));

      await expect(
        service.logDelayReason(principal(['branch-uuid-1']), 'missing', { reasonCategory: 'traffic' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
