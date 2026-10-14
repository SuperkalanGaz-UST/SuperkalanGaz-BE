import { ForbiddenException } from '@nestjs/common';
import { FindOperator, Repository } from 'typeorm';
import { Principal } from '../auth/principal';
import { GoTrueAdminService } from '../users/gotrue-admin.service';
import { Branch } from './branch.entity';
import { BranchesService } from './branches.service';

describe('BranchesService assigned branch configuration', () => {
  const makeRepo = () =>
    ({
      find: jest.fn(() => Promise.resolve([])),
    }) as unknown as jest.Mocked<Repository<Branch>>;

  const makeService = (repo: jest.Mocked<Repository<Branch>>) =>
    new BranchesService(repo, {} as GoTrueAdminService);

  const principal = (branchIds: string[]): Principal => ({
    userId: 'owner-1',
    role: 'branch-owner',
    branches: ['Amadeo, Cavite'],
    branchIds,
  });

  it('loads geofences only from the authenticated owner branch UUIDs', async () => {
    const repo = makeRepo();
    const service = makeService(repo);

    await service.listAssigned(principal(['branch-1', 'branch-2']));

    const options = repo.find.mock.calls[0][0];
    const where = options?.where as { id: FindOperator<string>; status: string };
    expect(where.id.value).toEqual(['branch-1', 'branch-2']);
    expect(where.status).toBe('active');
    expect(options?.select).toEqual({ id: true, name: true, geofence: true });
  });

  it('fails closed when the owner has no active assigned branch', async () => {
    const repo = makeRepo();
    const service = makeService(repo);

    await expect(service.listAssigned(principal([]))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(repo.find).not.toHaveBeenCalled();
  });
});
