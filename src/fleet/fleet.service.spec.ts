import { ForbiddenException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { Principal } from '../auth/principal';
import { FleetService } from './fleet.service';
import { Rider } from './rider.entity';

/**
 * Unit coverage for the Fleet roster service. The focus is branch scoping and
 * the assignable-rider lookup the SRD dispatch flow relies on (panel-defense
 * points, AGENTS.md §5/§6), so the repository is faked; no database is touched.
 */
describe('FleetService', () => {
  const makeRepo = () =>
    ({
      find: jest.fn(() => Promise.resolve([])),
      findOne: jest.fn(() => Promise.resolve(null)),
      update: jest.fn(() => Promise.resolve({ affected: 1 })),
    }) as unknown as jest.Mocked<Repository<Rider>>;

  const principal = (branchIds: string[]): Principal => ({
    userId: 'user-1',
    role: 'branch-manager',
    branches: ['Alpha'],
    branchIds,
  });

  it('scopes the roster to the caller branches and excludes soft-deleted rows', async () => {
    const repo = makeRepo();
    const service = new FleetService(repo);

    await service.listForBranch(principal(['branch-uuid-1', 'branch-uuid-2']), {});

    const where = repo.find.mock.calls[0][0]?.where as Record<string, unknown>;
    expect(where).toHaveProperty('branchId');
    expect(where).toHaveProperty('deletedAt');
    // No status filter passed → the roster is not narrowed by status.
    expect(where).not.toHaveProperty('status');
    expect(repo.find.mock.calls[0][0]?.order).toEqual({ name: 'ASC' });
  });

  it('applies the optional status filter (the dispatch dropdown passes Available)', async () => {
    const repo = makeRepo();
    const service = new FleetService(repo);

    await service.listForBranch(principal(['branch-uuid-1']), { status: 'Available' });

    const where = repo.find.mock.calls[0][0]?.where as Record<string, unknown>;
    expect(where.status).toBe('Available');
  });

  it('fails closed when the caller has no active branch', async () => {
    const repo = makeRepo();
    const service = new FleetService(repo);

    await expect(
      service.listForBranch(principal([]), {}),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repo.find).not.toHaveBeenCalled();
  });

  it('looks up an assignable rider by id, branch, Available status, and live row', async () => {
    const repo = makeRepo();
    const service = new FleetService(repo);

    await service.findAssignableRider('rider-1', 'branch-uuid-1');

    const where = repo.findOne.mock.calls[0][0]?.where as Record<string, unknown>;
    expect(where.id).toBe('rider-1');
    expect(where.branchId).toBe('branch-uuid-1');
    expect(where.status).toBe('Available');
    expect(where).toHaveProperty('deletedAt');
  });

  it('flips a rider to On Delivery and bumps updated_at', async () => {
    const repo = makeRepo();
    const service = new FleetService(repo);

    await service.markOnDelivery('rider-1');

    expect(repo.update).toHaveBeenCalledTimes(1);
    const [criteria, patch] = repo.update.mock.calls[0];
    expect(criteria).toEqual({ id: 'rider-1' });
    expect((patch as Partial<Rider>).status).toBe('On Delivery');
    expect((patch as Partial<Rider>).updatedAt).toBeInstanceOf(Date);
  });
});
