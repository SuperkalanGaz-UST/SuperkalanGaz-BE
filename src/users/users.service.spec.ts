import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { Principal } from '../auth/principal';
import { Branch } from '../branches/branch.entity';
import { GovernanceAuditService } from '../governance/governance-audit.service';
import { GoTrueAdminService, GoTrueUser } from './gotrue-admin.service';
import { UsersService } from './users.service';

/** M1: every test constructs a fresh no-op audit mock unless it asserts on it. */
const makeAudit = () =>
  ({ record: jest.fn().mockResolvedValue(undefined) }) as unknown as jest.Mocked<GovernanceAuditService>;

describe('UsersService self-service account updates', () => {
  const principal: Principal = {
    userId: '2da286c8-76d7-43a7-8394-0e0c74c561d0',
    role: 'franchise-admin',
    email: 'admin@superkalan.com',
    username: 'admin',
    displayName: 'Franchise Administrator',
    phone: '+639171234567',
    status: 'Active',
    branches: [],
    branchIds: [],
  };

  const authUser: GoTrueUser = {
    id: principal.userId,
    email: 'admin@superkalan.com',
    app_metadata: {
      username: 'admin',
      display_name: 'Franchise Administrator',
      role: 'franchise-admin',
      branches: [],
      phone: '+639171234567',
      status: 'Active',
    },
    user_metadata: {},
    banned_until: null,
    created_at: '2026-01-10T00:00:00.000Z',
  };

  let goTrue: jest.Mocked<Pick<GoTrueAdminService, 'getUser' | 'updateUser'>>;
  const branchRepository = {
    find: jest.fn().mockResolvedValue([]),
  } as unknown as Repository<Branch>;
  let service: UsersService;

  beforeEach(() => {
    goTrue = {
      getUser: jest.fn().mockResolvedValue(authUser),
      updateUser: jest.fn().mockResolvedValue(undefined),
    };
    service = new UsersService(
      goTrue as unknown as GoTrueAdminService,
      branchRepository,
      makeAudit(),
    );
  });

  it('updates personal fields without accepting changes to trusted claims', async () => {
    const updated = await service.updateOwnProfile(principal, {
      email: 'franchise.admin@superkalan.com',
      name: 'Franchise Admin',
      phone: '+639189876543',
    });

    // H1 regression: role/branch_ids/branches/status must NEVER appear in this
    // write — they'd be re-derived from a possibly-stale token and could
    // silently resurrect revoked access (see UsersService.updateOwnProfile).
    expect(goTrue.updateUser).toHaveBeenCalledWith(principal.userId, {
      email: 'franchise.admin@superkalan.com',
      app_metadata: {
        username: 'admin',
        display_name: 'Franchise Admin',
        phone: '+639189876543',
      },
    });
    expect(goTrue.getUser).not.toHaveBeenCalled();
    expect(updated).toMatchObject({
      email: 'franchise.admin@superkalan.com',
      displayName: 'Franchise Admin',
      phone: '+639189876543',
      role: 'franchise-admin',
      branchIds: [],
      branches: [],
      status: 'Active',
    });
  });

  it('changes only the authenticated caller password', async () => {
    await service.changeOwnPassword(principal, 'new-password-123');

    expect(goTrue.getUser).not.toHaveBeenCalled();
    expect(goTrue.updateUser).toHaveBeenCalledWith(principal.userId, {
      password: 'new-password-123',
    });
  });
});

describe('UsersService governance boundaries', () => {
  const branchId = '11111111-1111-4111-8111-111111111111';
  const principal: Principal = {
    userId: '2da286c8-76d7-43a7-8394-0e0c74c561d0',
    role: 'franchise-admin',
    branches: [],
    branchIds: [],
  };

  it('blocks direct Branch Owner reassignment outside the approval queue', async () => {
    const owner: GoTrueUser = {
      id: 'b54295ca-2d97-4c77-8a31-c06ded29d93f',
      email: 'owner@superkalan.com',
      app_metadata: {
        role: 'branch-owner',
        branch_ids: [branchId],
        branches: ['Quezon City'],
        status: 'Active',
      },
      user_metadata: {},
      banned_until: null,
      created_at: '2026-01-10T00:00:00.000Z',
    };
    const goTrue = {
      getUser: jest.fn().mockResolvedValue(owner),
      updateUser: jest.fn(),
    } as unknown as GoTrueAdminService;
    const branchRepository = {
      find: jest.fn().mockResolvedValue([
        { id: branchId, name: 'Quezon City', status: 'active' },
      ]),
    } as unknown as Repository<Branch>;
    const service = new UsersService(goTrue, branchRepository, makeAudit());

    await expect(
      service.update(principal, owner.id, {
        branchIds: ['22222222-2222-4222-8222-222222222222'],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('M1: audits a credential change but never records the raw password', async () => {
    const target: GoTrueUser = {
      id: 'b54295ca-2d97-4c77-8a31-c06ded29d93f',
      email: 'manager@superkalan.com',
      app_metadata: {
        role: 'branch-manager',
        branch_ids: [branchId],
        branches: ['Quezon City'],
        status: 'Active',
      },
      user_metadata: {},
      banned_until: null,
      created_at: '2026-01-10T00:00:00.000Z',
    };
    const goTrue = {
      getUser: jest.fn().mockResolvedValue(target),
      updateUser: jest.fn().mockResolvedValue(undefined),
    } as unknown as GoTrueAdminService;
    const branchRepository = {
      find: jest.fn().mockResolvedValue([
        { id: branchId, name: 'Quezon City', status: 'active' },
      ]),
    } as unknown as Repository<Branch>;
    const audit = makeAudit();
    const service = new UsersService(goTrue, branchRepository, audit);
    const faPrincipal: Principal = {
      userId: 'fa-1',
      role: 'franchise-admin',
      displayName: 'Franchise Admin',
      branches: [],
      branchIds: [],
    };

    await service.update(faPrincipal, target.id, { password: 'new-password-123' });

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'admin-account',
        action: 'admin-credential-change',
        actor: faPrincipal,
        affectedRecordType: 'user',
        affectedRecordId: target.id,
        afterState: { passwordReset: true },
      }),
    );
    const [[recordedCall]] = audit.record.mock.calls;
    expect(JSON.stringify(recordedCall)).not.toContain('new-password-123');
  });

  it('does not audit when the update touches no credential field', async () => {
    const target: GoTrueUser = {
      id: 'b54295ca-2d97-4c77-8a31-c06ded29d93f',
      email: 'manager@superkalan.com',
      app_metadata: {
        role: 'branch-manager',
        branch_ids: [branchId],
        branches: ['Quezon City'],
        status: 'Active',
      },
      user_metadata: {},
      banned_until: null,
      created_at: '2026-01-10T00:00:00.000Z',
    };
    const goTrue = {
      getUser: jest.fn().mockResolvedValue(target),
      updateUser: jest.fn().mockResolvedValue(undefined),
    } as unknown as GoTrueAdminService;
    const branchRepository = {
      find: jest.fn().mockResolvedValue([
        { id: branchId, name: 'Quezon City', status: 'active' },
      ]),
    } as unknown as Repository<Branch>;
    const audit = makeAudit();
    const service = new UsersService(goTrue, branchRepository, audit);

    await service.update(principal, target.id, { phone: '+639171234567' });

    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('UsersService multi-branch owner scope', () => {
  const firstBranchId = '11111111-1111-4111-8111-111111111111';
  const secondBranchId = '22222222-2222-4222-8222-222222222222';
  const outsideBranchId = '33333333-3333-4333-8333-333333333333';

  it('rejects a Branch Manager assignment containing multiple UUIDs', async () => {
    const goTrue = {
      createUser: jest.fn(),
    } as unknown as GoTrueAdminService;
    const branchRepository = {
      find: jest.fn(),
    } as unknown as Repository<Branch>;
    const service = new UsersService(goTrue, branchRepository, makeAudit());
    const owner: Principal = {
      userId: 'owner',
      role: 'branch-owner',
      branchIds: [firstBranchId, secondBranchId],
      branches: ['Alfonso, Cavite', 'Las Pinas 1'],
    };

    await expect(
      service.create(owner, {
        email: 'manager@example.com',
        password: 'password123',
        role: 'branch-manager',
        branchIds: [firstBranchId, secondBranchId],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(goTrue.createUser).not.toHaveBeenCalled();
    expect(branchRepository.find).not.toHaveBeenCalled();
  });

  it('lists managers overlapping any authorized owner UUID without trusting names', async () => {
    const makeManager = (id: string, branchId: string, branchName: string): GoTrueUser => ({
      id,
      email: `${id}@example.com`,
      app_metadata: {
        role: 'branch-manager',
        branch_ids: [branchId],
        branches: [branchName],
        status: 'Active',
      },
      user_metadata: {},
      banned_until: null,
      created_at: '2026-01-10T00:00:00.000Z',
      last_sign_in_at: '2026-08-30T02:15:00.000Z',
    });
    const goTrue = {
      listUsers: jest.fn().mockResolvedValue([
        makeManager('manager-one', firstBranchId, 'Renamed display label'),
        makeManager('manager-two', secondBranchId, 'Las Pinas 1'),
        makeManager('manager-outside', outsideBranchId, 'Outside'),
      ]),
    } as unknown as GoTrueAdminService;
    const branchRepository = {
      find: jest.fn().mockResolvedValue([
        { id: firstBranchId, name: 'Alfonso, Cavite', status: 'active' },
        { id: secondBranchId, name: 'Las Pinas 1', status: 'active' },
        { id: outsideBranchId, name: 'Outside', status: 'active' },
      ]),
    } as unknown as Repository<Branch>;
    const service = new UsersService(goTrue, branchRepository, makeAudit());
    const owner: Principal = {
      userId: 'owner',
      role: 'branch-owner',
      branchIds: [firstBranchId, secondBranchId],
      branches: ['Alfonso, Cavite', 'Las Pinas 1'],
    };

    const users = await service.list(owner, { role: 'branch-manager' });

    expect(users.map((user) => user.id)).toEqual(['manager-one', 'manager-two']);
    expect(users[0]).toMatchObject({
      branchIds: [firstBranchId],
      branches: ['Alfonso, Cavite'],
      lastLoginAt: new Date('2026-08-30T02:15:00.000Z'),
    });
  });
});
