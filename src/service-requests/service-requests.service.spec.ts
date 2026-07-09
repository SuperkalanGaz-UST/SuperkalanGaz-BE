import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Repository } from 'typeorm';
import { Principal } from '../auth/principal';
import { FleetService } from '../fleet/fleet.service';
import { Rider } from '../fleet/rider.entity';
import { CreateServiceRequestDto } from './dto/create-service-request.dto';
import { ServiceRequest } from './service-request.entity';
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

  // Fake Fleet service: `findAssignableRider` returns a rider (or null when not
  // assignable); `markOnDelivery` is a spy.
  const makeFleet = (rider: Rider | null) =>
    ({
      findAssignableRider: jest.fn(() => Promise.resolve(rider)),
      markOnDelivery: jest.fn(() => Promise.resolve()),
    }) as unknown as jest.Mocked<FleetService>;

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
      dispatchedAt: null,
      riderId: null,
    }) as ServiceRequest;

  const availableRider = (): Rider =>
    ({ id: 'rider-1', branchId: 'branch-uuid-1', status: 'Available' }) as Rider;

  const dto: CreateServiceRequestDto = {
    customerName: '  Juan Dela Cruz ',
    customerContact: '09171234567',
    deliveryAddress: '123 Rizal St',
    cylinderSize: '11kg',
    quantity: 2,
  };

  it('files a request under the caller branch with server-owned fields', async () => {
    const { repo } = makeRepo();
    const service = new ServiceRequestsService(repo, makeFleet(null));

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
    expect(repo.save).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the caller has no active branch', async () => {
    const { repo } = makeRepo();
    const service = new ServiceRequestsService(repo, makeFleet(null));

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
    // Nothing should reach the data layer once scoping fails.
    expect(repo.save).not.toHaveBeenCalled();
    expect(repo.find).not.toHaveBeenCalled();
  });

  it('scopes the queue to the caller branches, newest first', async () => {
    const { repo } = makeRepo();
    const service = new ServiceRequestsService(repo, makeFleet(null));

    await service.list(principal(['branch-uuid-1', 'branch-uuid-2']));

    const where = repo.find.mock.calls[0][0]?.where as Record<string, unknown>;
    // branchId is filtered via In(...) and soft-deleted rows excluded.
    expect(where).toHaveProperty('branchId');
    expect(where).toHaveProperty('deletedAt');
    expect(repo.find.mock.calls[0][0]?.order).toEqual({ requestedAt: 'DESC' });
  });

  it('returns 404 for an id outside the caller scope or not found', async () => {
    const { repo } = makeRepo();
    const service = new ServiceRequestsService(repo, makeFleet(null));

    await expect(
      service.findById(principal(['branch-uuid-1']), 'missing'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  describe('dispatch', () => {
    it('assigns the rider, stamps dispatch, and flips the rider to On Delivery', async () => {
      const { repo, qb } = makeRepo(1);
      repo.findOne = jest.fn(() => Promise.resolve(pendingSr())) as never;
      const fleet = makeFleet(availableRider());
      const service = new ServiceRequestsService(repo, fleet);

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
      const service = new ServiceRequestsService(repo, fleet);

      await expect(
        service.dispatch(principal(['branch-uuid-1']), 'sr-1', { riderId: 'rider-1' }),
      ).rejects.toBeInstanceOf(ConflictException);
      // Bailed before validating a rider or touching the data layer.
      expect(fleet.findAssignableRider).not.toHaveBeenCalled();
      expect(qb.execute).not.toHaveBeenCalled();
    });

    it('409s when a concurrent dispatch won the race (0 rows affected)', async () => {
      // Row still looks Pending on load, but the conditional UPDATE touches 0
      // rows because another dispatch committed first (AGENTS.md §8.2).
      const { repo, qb } = makeRepo(0);
      repo.findOne = jest.fn(() => Promise.resolve(pendingSr())) as never;
      const fleet = makeFleet(availableRider());
      const service = new ServiceRequestsService(repo, fleet);

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
      const service = new ServiceRequestsService(repo, fleet);

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
      const service = new ServiceRequestsService(repo, fleet);

      await expect(
        service.dispatch(principal(['branch-uuid-1']), 'missing', { riderId: 'rider-1' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(fleet.findAssignableRider).not.toHaveBeenCalled();
    });
  });
});
