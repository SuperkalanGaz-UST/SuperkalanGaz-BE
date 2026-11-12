import { ForbiddenException } from '@nestjs/common';
import { FindOperator, Repository } from 'typeorm';
import { Principal } from '../auth/principal';
import { GoTrueAdminService } from '../users/gotrue-admin.service';
import { BranchOwnerInvitationsService } from './branch-owner-invitations.service';
import { Branch } from './branch.entity';
import { BranchesService } from './branches.service';

describe('BranchesService assigned branch configuration', () => {
  const makeRepo = () =>
    ({
      find: jest.fn(() => Promise.resolve([])),
    }) as unknown as jest.Mocked<Repository<Branch>>;

  const makeService = (repo: jest.Mocked<Repository<Branch>>) =>
    new BranchesService(repo, {} as GoTrueAdminService, {} as BranchOwnerInvitationsService);

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

describe('BranchesService invitation-based registration', () => {
  function setup() {
    const repository = {
      create: jest.fn((input: Record<string, unknown>) => ({ id: 'branch-a', ...input })),
      save: jest.fn(async (input: unknown) => input),
    };
    const auth = { createUser: jest.fn(), updateUser: jest.fn().mockResolvedValue(undefined), banUser: jest.fn().mockResolvedValue(undefined) };
    const invitations = { inviteNew: jest.fn().mockResolvedValue({ id: 'owner-a', email: 'owner@example.invalid', app_metadata: { role: 'branch-owner', status: 'Pending', branch_owner_invitation: true } }) };
    const service = new BranchesService(repository as unknown as Repository<Branch>, auth as unknown as GoTrueAdminService, invitations as unknown as BranchOwnerInvitationsService);
    return { service, repository, auth, invitations };
  }
  const principal: Principal = { userId: 'fa-a', role: 'franchise-admin', branchIds: [], branches: [] };
  const dto = { name: 'Branch A', address: 'Test address', ownerType: 'new' as const, ownerName: 'New Owner', ownerEmail: 'owner@example.invalid', ownerMobile: '+639171234567' };

  it('binds a pending invitation to the saved UUID and returns no temporary password', async () => {
    const { service, repository, auth } = setup();
    const result = await service.create(principal, dto);
    expect(result.owner).toEqual({ id: 'owner-a', email: 'owner@example.invalid', invitationSent: true });
    expect(auth.createUser).not.toHaveBeenCalled();
    expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'owner-a' }));
    expect(auth.updateUser).toHaveBeenCalledWith('owner-a', { app_metadata: expect.objectContaining({ status: 'Pending', branch_ids: ['branch-a'], invitation_branch_id: 'branch-a' }) });
  });

  it('does not save a branch or claim success when email sending fails', async () => {
    const { service, repository, invitations } = setup();
    invitations.inviteNew.mockRejectedValue(new Error('SMTP unavailable'));
    await expect(service.create(principal, dto)).rejects.toThrow('SMTP unavailable');
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('bans the invitation if branch persistence fails', async () => {
    const { service, repository, auth } = setup();
    repository.save.mockRejectedValue(new Error('Database unavailable'));
    await expect(service.create(principal, dto)).rejects.toThrow('Database unavailable');
    expect(auth.banUser).toHaveBeenCalledWith('owner-a');
  });
});
