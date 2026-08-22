import { ForbiddenException } from '@nestjs/common';
import { Principal } from '../auth/principal';
import { GoTrueAdminService, GoTrueUser } from './gotrue-admin.service';
import { UsersService } from './users.service';

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
  let service: UsersService;

  beforeEach(() => {
    goTrue = {
      getUser: jest.fn().mockResolvedValue(authUser),
      updateUser: jest.fn().mockResolvedValue(undefined),
    };
    service = new UsersService(goTrue as unknown as GoTrueAdminService);
  });

  it('updates personal fields without accepting changes to trusted claims', async () => {
    const updated = await service.updateOwnProfile(principal, {
      email: 'franchise.admin@superkalan.com',
      name: 'Franchise Admin',
      phone: '+639189876543',
    });

    expect(goTrue.updateUser).toHaveBeenCalledWith(principal.userId, {
      email: 'franchise.admin@superkalan.com',
      app_metadata: {
        username: 'admin',
        display_name: 'Franchise Admin',
        role: 'franchise-admin',
        branches: [],
        phone: '+639189876543',
        status: 'Active',
      },
    });
    expect(goTrue.getUser).not.toHaveBeenCalled();
    expect(updated).toMatchObject({
      email: 'franchise.admin@superkalan.com',
      displayName: 'Franchise Admin',
      phone: '+639189876543',
      role: 'franchise-admin',
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
    const service = new UsersService(goTrue);

    await expect(
      service.update(principal, owner.id, { branches: ['Calamba'] }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
