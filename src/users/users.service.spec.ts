import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Repository } from 'typeorm';
import { Principal } from '../auth/principal';
import { Branch } from '../branches/branch.entity';
import { GovernanceAuditService } from '../governance/governance-audit.service';
import { GoTrueAdminService, GoTrueUser } from './gotrue-admin.service';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateOwnProfileDto } from './dto/update-own-profile.dto';

/** M1: every test constructs a fresh no-op audit mock unless it asserts on it. */
const makeAudit = () =>
  ({ record: jest.fn().mockResolvedValue(undefined) }) as unknown as jest.Mocked<GovernanceAuditService>;

const config = new ConfigService({ WEB_ORIGIN: 'https://crm.example.invalid' });

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

  let goTrue: jest.Mocked<Pick<GoTrueAdminService, 'getUser' | 'updateUser' | 'listUsers'>>;
  const branchRepository = {
    find: jest.fn().mockResolvedValue([]),
  } as unknown as Repository<Branch>;
  let service: UsersService;

  beforeEach(() => {
    goTrue = {
      getUser: jest.fn().mockResolvedValue(authUser),
      updateUser: jest.fn().mockResolvedValue(undefined),
      listUsers: jest.fn().mockResolvedValue([authUser]),
    };
    service = new UsersService(
      goTrue as unknown as GoTrueAdminService,
      branchRepository,
      makeAudit(),
      config,
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

  it.each<Principal['role']>(['super-admin', 'franchise-admin', 'branch-owner', 'branch-manager'])(
    'lets %s update only its own username without rewriting stale scope', async (role) => {
      const updated = await service.updateOwnProfile({ ...principal, role }, { username: ' New.Name ' });
      expect(goTrue.updateUser).toHaveBeenCalledWith(principal.userId, {
        app_metadata: { username: 'new.name' },
      });
      expect(updated.username).toBe('new.name');
    },
  );

  it('reserves case-insensitive usernames even for inactive accounts', async () => {
    goTrue.listUsers.mockResolvedValue([{ ...authUser, id: 'another-user', app_metadata: {
      username: 'TAKEN', role: 'branch-manager', status: 'Inactive',
    } }]);
    await expect(service.updateOwnProfile(principal, { username: 'taken' })).rejects.toBeInstanceOf(ConflictException);
    expect(goTrue.updateUser).not.toHaveBeenCalled();
  });

  it('does not overwrite the current username when a stale session saves another field', async () => {
    await service.updateOwnProfile(principal, { phone: '+639189876543' });
    expect(goTrue.updateUser).toHaveBeenCalledWith(principal.userId, {
      app_metadata: { phone: '+639189876543' },
    });
    expect(goTrue.listUsers).not.toHaveBeenCalled();
  });

  it('does not write when username availability cannot be checked', async () => {
    goTrue.listUsers.mockRejectedValue(new Error('Auth unavailable'));
    await expect(service.updateOwnProfile(principal, { username: 'new.name' })).rejects.toThrow('Auth unavailable');
    expect(goTrue.updateUser).not.toHaveBeenCalled();
  });

  it('changes only the authenticated caller password', async () => {
    await service.changeOwnPassword(principal, 'new-password-123');

    expect(goTrue.getUser).not.toHaveBeenCalled();
    expect(goTrue.updateUser).toHaveBeenCalledWith(principal.userId, {
      password: 'new-password-123',
    });
  });
});

describe('self-service username validation', () => {
  it.each(['', 'ab', 'bad name', 'bad@email.com', 'a'.repeat(65), null, 123])('rejects %p', async (username) => {
    const errors = await validate(plainToInstance(UpdateOwnProfileDto, { username }));
    expect(errors.some((error) => error.property === 'username')).toBe(true);
  });

  it('normalizes usernames and strips privilege changes at the request boundary', async () => {
    const dto = plainToInstance(UpdateOwnProfileDto, {
      username: ' New.Name_1 ', role: 'super-admin', branch_ids: ['outside'], status: 'Active',
    });
    expect(await validate(dto, { whitelist: true })).toEqual([]);
    expect(dto).toEqual({ username: 'new.name_1' });
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
    const service = new UsersService(goTrue, branchRepository, makeAudit(), config);

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
    const service = new UsersService(goTrue, branchRepository, audit, config);
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
    const service = new UsersService(goTrue, branchRepository, audit, config);

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
    const service = new UsersService(goTrue, branchRepository, makeAudit(), config);
    const owner: Principal = {
      userId: 'owner',
      role: 'branch-owner',
      branchIds: [firstBranchId, secondBranchId],
      branches: ['Alfonso, Cavite', 'Las Pinas 1'],
    };

    await expect(
      service.create(owner, {
        email: 'manager@example.com',
        name: 'Invited Manager',
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
    const service = new UsersService(goTrue, branchRepository, makeAudit(), config);
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

describe('Branch Owner invitation account boundaries', () => {
  const principal: Principal = { userId: 'franchise-a', role: 'franchise-admin', branchIds: [], branches: [] };
  function setup() {
    const user: GoTrueUser = { id: 'invited-owner', email: 'invited@example.invalid', banned_until: null,
      created_at: new Date().toISOString(), user_metadata: {},
      app_metadata: { role: 'branch-owner', status: 'Pending', branch_owner_invitation: true, branch_ids: ['branch-a'] } };
    const auth = { getUser: jest.fn().mockResolvedValue(user), listUsers: jest.fn().mockResolvedValue([user]), createUser: jest.fn(), updateUser: jest.fn() };
    const branches = { find: jest.fn().mockResolvedValue([{ id: 'branch-a', name: 'Branch A', ownerId: user.id }]) };
    return { service: new UsersService(auth as unknown as GoTrueAdminService, branches as unknown as Repository<Branch>, makeAudit(), config), auth };
  }
  it('preserves Pending status in the directory rather than advertising active access', async () => {
    const { service } = setup();
    expect(await service.list(principal, { role: 'branch-owner' })).toEqual([expect.objectContaining({ id: 'invited-owner', status: 'Pending' })]);
  });
  it('cannot activate an invitation or set its password through ordinary profile editing', async () => {
    const { service, auth } = setup();
    await expect(service.update(principal, 'invited-owner', { status: 'Active', password: 'AdminChosenPassword1' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(auth.updateUser).not.toHaveBeenCalled();
  });
});

describe('Branch Manager email invitations', () => {
  const branch = { id: '00000000-0000-4000-8000-000000000001', name: 'Branch A', ownerId: 'owner-a' };
  const owner: Principal = {
    userId: branch.ownerId, role: 'branch-owner', branchIds: [branch.id], branches: [branch.name],
  };
  const email = 'manager@example.invalid';
  const invited: GoTrueUser = {
    id: 'manager-a', email, banned_until: null,
    created_at: '2026-01-10T00:00:00.000Z', user_metadata: {}, app_metadata: {},
  };
  const manager: Principal = {
    userId: invited.id, role: 'branch-manager', email, status: 'Pending',
    branchIds: [branch.id], branches: [branch.name],
  };

  function setup() {
    const auth = {
      inviteUser: jest.fn().mockResolvedValue(invited),
      findByEmail: jest.fn().mockResolvedValue(null),
      getUser: jest.fn(),
      updateUser: jest.fn().mockResolvedValue(undefined),
      sendExistingUserLink: jest.fn().mockResolvedValue(undefined),
    };
    const locked = { findOne: jest.fn().mockResolvedValue(branch), query: jest.fn() };
    const repo = { manager: { transaction: jest.fn((callback) => callback(locked)) } };
    const service = new UsersService(
      auth as unknown as GoTrueAdminService, repo as unknown as Repository<Branch>, makeAudit(), config,
    );
    const pending: GoTrueUser = {
      ...invited,
      email_confirmed_at: '2026-01-10T00:01:00.000Z',
      app_metadata: {
        role: 'branch-manager', status: 'Pending', branch_ids: [branch.id],
        branch_manager_invitation: true, invitation_email: email,
        invitation_expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
    };
    auth.getUser.mockResolvedValue(pending);
    return { service, auth, locked, pending };
  }

  it('rejects other roles and strips legacy credential fields at the account creation boundary', async () => {
    const dto = plainToInstance(CreateUserDto, {
      email, name: 'New Manager', branchIds: [branch.id], role: 'branch-owner',
      password: 'AdminChosenPassword1', status: 'Active',
    });
    expect((await validate(dto, { whitelist: true })).map((error) => error.property)).toEqual(['role']);
    expect(dto).not.toHaveProperty('password');
    expect(dto).not.toHaveProperty('status');
  });

  it('sends the email and assigns protected Pending claims without a password', async () => {
    const { service, auth, locked } = setup();
    await expect(service.create(owner, { email: email.toUpperCase(), name: 'New Manager', branchIds: [branch.id] }))
      .resolves.toEqual({ id: invited.id });
    expect(locked.findOne).toHaveBeenCalledWith(Branch, expect.objectContaining({
      where: { id: branch.id, ownerId: owner.userId, status: 'active' },
    }));
    expect(auth.inviteUser).toHaveBeenCalledWith(email, 'New Manager', 'https://crm.example.invalid/?invitation=branch-manager');
    expect(auth.updateUser).toHaveBeenCalledWith(invited.id, {
      app_metadata: expect.objectContaining({
        role: 'branch-manager', status: 'Pending', branch_ids: [branch.id], invitation_email: email,
      }),
    });
  });

  it('refuses duplicate addresses and a branch whose ownership no longer matches', async () => {
    const { service, auth, locked } = setup();
    const input = { email, name: 'New Manager', branchIds: [branch.id] };
    auth.findByEmail.mockResolvedValue(invited);
    await expect(service.create(owner, input)).rejects.toThrow('Email already in use');
    locked.findOne.mockResolvedValue(null);
    await expect(service.create(owner, input)).rejects.toBeInstanceOf(ForbiddenException);
    expect(auth.inviteUser).not.toHaveBeenCalled();
  });

  it.each(['unverified', 'expired', 'wrong branch', 'wrong email', 'revoked'])(
    'denies %s invitations without writing a password',
    async (condition) => {
      const { service, auth, pending } = setup();
      if (condition === 'unverified') pending.email_confirmed_at = null;
      if (condition === 'expired') pending.app_metadata.invitation_expires_at = new Date(0).toISOString();
      if (condition === 'wrong branch') pending.app_metadata.branch_ids = ['other-branch'];
      if (condition === 'wrong email') pending.email = 'other@example.invalid';
      if (condition === 'revoked') pending.app_metadata.status = 'Inactive';
      await expect(service.acceptManagerInvitation(manager, 'ChosenPassword1')).rejects.toBeInstanceOf(ForbiddenException);
      expect(auth.updateUser).not.toHaveBeenCalled();
    },
  );

  it('activates once and leaves the chosen password intact when the request is replayed', async () => {
    const { service, auth, pending } = setup();
    await service.acceptManagerInvitation(manager, 'ChosenPassword1');
    expect(auth.updateUser).toHaveBeenCalledWith(invited.id, {
      password: 'ChosenPassword1',
      app_metadata: { status: 'Active', invitation_accepted_at: expect.any(String) },
    });
    pending.app_metadata.status = 'Active';
    pending.app_metadata.invitation_accepted_at = new Date().toISOString();
    await service.acceptManagerInvitation(manager, 'DifferentPassword1');
    expect(auth.updateUser).toHaveBeenCalledTimes(1);
  });

  it('resends a fresh email to the already verified pending identity without creating another user', async () => {
    const { service, auth } = setup();
    await service.resendManagerInvitation(owner, invited.id, branch.id);
    expect(auth.sendExistingUserLink).toHaveBeenCalledWith(email, 'https://crm.example.invalid/?invitation=branch-manager');
    expect(auth.inviteUser).not.toHaveBeenCalled();
  });
});
