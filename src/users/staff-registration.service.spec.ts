import { ConflictException, NotFoundException } from '@nestjs/common';
import { GoTrueAdminService, GoTrueUser } from './gotrue-admin.service';
import { StaffRegistrationService } from './staff-registration.service';

function user(
  id: string,
  role: string,
  status: string,
  overrides: Partial<GoTrueUser> = {},
): GoTrueUser {
  return {
    id,
    email: `${id}@example.com`,
    app_metadata: {
      role,
      status,
      display_name: id,
      branches: ['Main Office'],
      phone: '+639171234567',
    },
    user_metadata: {},
    banned_until: null,
    created_at: '2026-08-20T00:00:00.000Z',
    ...overrides,
  };
}

describe('StaffRegistrationService', () => {
  it('lists only unbanned pending Branch Owner and Branch Manager accounts', async () => {
    const users = [
      user('owner', 'branch-owner', 'Pending'),
      user('manager', 'branch-manager', 'Pending', {
        created_at: '2026-08-21T00:00:00.000Z',
      }),
      user('active-owner', 'branch-owner', 'Active'),
      user('admin', 'franchise-admin', 'Pending'),
      user('customer', 'customer', 'Pending'),
      user('banned-manager', 'branch-manager', 'Pending', {
        banned_until: '2099-01-01T00:00:00.000Z',
      }),
    ];
    const goTrue = {
      listUsers: jest.fn().mockResolvedValue(users),
    } as unknown as GoTrueAdminService;
    const service = new StaffRegistrationService(goTrue);

    await expect(service.list({ status: 'pending' })).resolves.toEqual([
      expect.objectContaining({
        id: 'manager',
        role: 'branch-manager',
        branch_name: 'Main Office',
      }),
      expect.objectContaining({
        id: 'owner',
        role: 'branch-owner',
        applicant_phone: '+639171234567',
      }),
    ]);
  });

  it('narrows results to the requested approved role values', async () => {
    const goTrue = {
      listUsers: jest.fn().mockResolvedValue([
        user('owner', 'branch-owner', 'Pending'),
        user('manager', 'branch-manager', 'Pending'),
      ]),
    } as unknown as GoTrueAdminService;
    const service = new StaffRegistrationService(goTrue);

    const rows = await service.list({ roles: 'branch-manager' });

    expect(rows.map((row) => row.id)).toEqual(['manager']);
  });

  it('returns an authoritative empty document set for a pending request', async () => {
    const goTrue = {
      getUser: jest.fn().mockResolvedValue(user('owner', 'branch-owner', 'Pending')),
    } as unknown as GoTrueAdminService;
    const service = new StaffRegistrationService(goTrue);

    await expect(service.documents('owner')).resolves.toEqual([]);
  });

  it('fails closed when a decision has no secure registration documents', async () => {
    const goTrue = {
      getUser: jest.fn().mockResolvedValue(user('owner', 'branch-owner', 'Pending')),
    } as unknown as GoTrueAdminService;
    const service = new StaffRegistrationService(goTrue);

    await expect(
      service.decide('owner', { decision: 'approve', reason: 'Documents reviewed' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('does not disclose active or non-reviewable accounts as requests', async () => {
    const goTrue = {
      getUser: jest.fn().mockResolvedValue(user('active-owner', 'branch-owner', 'Active')),
    } as unknown as GoTrueAdminService;
    const service = new StaffRegistrationService(goTrue);

    await expect(service.documents('active-owner')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
