import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { Principal } from '../auth/principal';
import { CreateServiceRequestDto } from './dto/create-service-request.dto';
import { ServiceRequest } from './service-request.entity';
import { ServiceRequestsService } from './service-requests.service';

/**
 * Unit coverage for the SRD intake/queue service. The focus is branch scoping
 * and server-owned fields — the panel-defense points (AGENTS.md §5, §8.2) — so
 * the repository is faked; no database is touched.
 */
describe('ServiceRequestsService', () => {
  // Minimal fake standing in for the TypeORM repository. `create` echoes its
  // input (as the real one does) and `save`/`find`/`findOne` are spies.
  const makeRepo = () =>
    ({
      create: jest.fn((v: Partial<ServiceRequest>) => v as ServiceRequest),
      save: jest.fn((v: ServiceRequest) => Promise.resolve(v)),
      find: jest.fn(() => Promise.resolve([])),
      findOne: jest.fn(() => Promise.resolve(null)),
    }) as unknown as jest.Mocked<Repository<ServiceRequest>>;

  const principal = (branchIds: string[]): Principal => ({
    userId: 'user-1',
    role: 'branch-manager',
    branches: ['Alpha'],
    branchIds,
  });

  const dto: CreateServiceRequestDto = {
    customerName: '  Juan Dela Cruz ',
    customerContact: '09171234567',
    deliveryAddress: '123 Rizal St',
    cylinderSize: '11kg',
    quantity: 2,
  };

  it('files a request under the caller branch with server-owned fields', async () => {
    const repo = makeRepo();
    const service = new ServiceRequestsService(repo);

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
    const repo = makeRepo();
    const service = new ServiceRequestsService(repo);

    await expect(service.create(principal([]), dto)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.list(principal([]))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.findById(principal([]), 'x')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    // Nothing should reach the data layer once scoping fails.
    expect(repo.save).not.toHaveBeenCalled();
    expect(repo.find).not.toHaveBeenCalled();
  });

  it('scopes the queue to the caller branches, newest first', async () => {
    const repo = makeRepo();
    const service = new ServiceRequestsService(repo);

    await service.list(principal(['branch-uuid-1', 'branch-uuid-2']));

    const where = repo.find.mock.calls[0][0]?.where as Record<string, unknown>;
    // branchId is filtered via In(...) and soft-deleted rows excluded.
    expect(where).toHaveProperty('branchId');
    expect(where).toHaveProperty('deletedAt');
    expect(repo.find.mock.calls[0][0]?.order).toEqual({ requestedAt: 'DESC' });
  });

  it('returns 404 for an id outside the caller scope or not found', async () => {
    const repo = makeRepo();
    const service = new ServiceRequestsService(repo);

    await expect(
      service.findById(principal(['branch-uuid-1']), 'missing'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
