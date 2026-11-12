import {
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { Principal } from '../auth/principal';
import { Branch } from '../branches/branch.entity';
import { GovernanceAuditService } from '../governance/governance-audit.service';
import { GoTrueAdminService, GoTrueUser } from '../users/gotrue-admin.service';
import { DeliveryRiderInvitationsService } from './delivery-rider-invitations.service';
import { Rider } from './rider.entity';

describe('DeliveryRiderInvitationsService', () => {
  const branchId = '11111111-1111-4111-8111-111111111111';
  const owner: Principal = {
    userId: '22222222-2222-4222-8222-222222222222',
    role: 'branch-owner',
    displayName: 'Branch Owner',
    branches: ['Amadeo, Cavite'],
    branchIds: [branchId],
  };
  const branch = {
    id: branchId,
    name: 'Amadeo, Cavite',
    status: 'active',
  } as Branch;

  function setup(options: {
    redirectUrl?: string | null;
  } = {}) {
    const user: GoTrueUser = {
      id: '33333333-3333-4333-8333-333333333333',
      email: 'rider@example.com',
      phone: null,
      app_metadata: {},
      user_metadata: {},
      banned_until: null,
      created_at: '2026-08-30T01:00:00.000Z',
      invited_at: '2026-08-30T01:00:00.000Z',
      confirmation_sent_at: '2026-08-30T01:00:00.000Z',
      email_confirmed_at: '2026-08-30T01:01:00.000Z',
    };
    let redirectUrl = '';
    const goTrue = {
      listUsers: jest.fn(async () => (user.app_metadata.role ? [user] : [])),
      inviteUser: jest.fn(async (_email: string, _name: string, redirect: string) => {
        redirectUrl = redirect;
        return user;
      }),
      updateUser: jest.fn(async (_id: string, attrs: Record<string, unknown>) => {
        if (attrs.app_metadata) {
          user.app_metadata = {
            ...user.app_metadata,
            ...(attrs.app_metadata as Record<string, unknown>),
          };
        }
        if (typeof attrs.phone === 'string') user.phone = attrs.phone;
      }),
      getUser: jest.fn(async () => user),
      banUser: jest.fn(async () => undefined),
      unbanUser: jest.fn(async () => {
        user.banned_until = null;
      }),
      sendExistingUserLink: jest.fn(
        async (_email: string, redirect: string) => {
          redirectUrl = redirect;
        },
      ),
    } as unknown as jest.Mocked<GoTrueAdminService>;
    const branches = {
      findOne: jest.fn(async () => branch),
      find: jest.fn(async () => [branch]),
    } as unknown as Repository<Branch>;
    const savedRider = {
      id: '44444444-4444-4444-8444-444444444444',
    } as Rider;
    const riders = {
      create: jest.fn((value: Partial<Rider>) => value as Rider),
      save: jest.fn(async () => savedRider),
      findOne: jest.fn(async (): Promise<Rider | null> => null),
      update: jest.fn(async () => ({ affected: 1 })),
    } as unknown as Repository<Rider>;
    const audit = {
      record: jest.fn(async () => undefined),
    } as unknown as GovernanceAuditService;
    const config = {
      get: jest.fn((key: string) =>
        key === 'DELIVERY_RIDER_INVITATION_REDIRECT_URL'
          ? options.redirectUrl === undefined
            ? 'superkalan://delivery-rider-invitation'
            : options.redirectUrl
          : key === 'WEB_ORIGIN'
            ? 'http://localhost:3000'
            : key === 'DELIVERY_RIDER_INVITATION_EXPIRY_HOURS'
              ? '48'
              : undefined,
      ),
    } as unknown as ConfigService;
    const service = new DeliveryRiderInvitationsService(
      branches,
      riders,
      goTrue,
      audit,
      config,
    );
    return { service, user, goTrue, riders, savedRider, audit, redirect: () => redirectUrl };
  }

  function acceptedDriver(user: GoTrueUser): Principal {
    user.app_metadata = {
      role: 'driver', status: 'Pending', branch_ids: [branchId],
      delivery_rider_invited_by: owner.userId,
      delivery_rider_account_created_at: new Date().toISOString(),
      delivery_rider_invitation_accepted_at: new Date().toISOString(),
    };
    return { userId: user.id, role: 'driver', status: 'Pending', branches: [branch.name], branchIds: [branchId] };
  }

  it('confirms contact details without verifying or attaching an Auth phone', async () => {
    const { service, user, goTrue, riders, audit } = setup();
    const driver = acceptedDriver(user);
    await expect(service.detailsForSession(driver)).resolves.toMatchObject({ invitationId: user.id });
    await service.confirmDetailsForSession(driver);
    expect(user.app_metadata.status).toBe('Active');
    expect(user.app_metadata.delivery_rider_details_confirmed_at).toEqual(expect.any(String));
    await expect(service.detailsForSession(driver)).resolves.toMatchObject({ mobileVerified: false });
    expect(goTrue.updateUser.mock.lastCall?.[1]).not.toHaveProperty('phone');
    expect(goTrue.updateUser.mock.lastCall?.[1]).not.toHaveProperty('phone_confirm');
    expect(riders.create).toHaveBeenCalledWith(expect.objectContaining({ authUserId: driver.userId, branchId, status: 'Offline' }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      afterState: expect.objectContaining({ detailsConfirmation: 'Confirmed' }),
    }));
    await service.confirmDetailsForSession(driver);
    expect(riders.save).toHaveBeenCalledTimes(1);
  });

  it('reuses the same branch roster entry when activation is retried after an Auth error', async () => {
    const { service, user, goTrue, riders, savedRider, audit } = setup();
    const driver = acceptedDriver(user);
    goTrue.updateUser.mockRejectedValueOnce(new Error('Auth unavailable'));

    await expect(service.confirmDetailsForSession(driver)).rejects.toThrow('Auth unavailable');
    expect(user.app_metadata.status).toBe('Pending');
    jest.mocked(riders.findOne).mockResolvedValueOnce(savedRider);

    await service.confirmDetailsForSession(driver);

    expect(riders.findOne).toHaveBeenLastCalledWith({
      where: { authUserId: user.id, branchId, deletedAt: expect.anything() },
    });
    expect(riders.save).toHaveBeenCalledTimes(1);
    expect(user.app_metadata.status).toBe('Active');
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it.each(['role', 'identity', 'branch', 'unverified email', 'unaccepted', 'revoked', 'inactive'] as const)('rejects %s details confirmation', async (reason) => {
    const { service, user, goTrue, riders } = setup();
    const driver = acceptedDriver(user);
    if (reason === 'role') driver.role = 'customer';
    if (reason === 'identity') driver.userId = owner.userId;
    if (reason === 'branch') driver.branchIds = [];
    if (reason === 'unverified email') user.email_confirmed_at = null;
    if (reason === 'unaccepted') delete user.app_metadata.delivery_rider_invitation_accepted_at;
    if (reason === 'revoked') user.app_metadata.delivery_rider_invitation_revoked_at = new Date().toISOString();
    if (reason === 'inactive') user.app_metadata.status = 'Inactive';
    await expect(service.confirmDetailsForSession(driver)).rejects.toBeInstanceOf(ForbiddenException);
    expect(goTrue.updateUser).not.toHaveBeenCalled();
    expect(riders.save).not.toHaveBeenCalled();
  });

  it('fails closed when a Branch Owner tries to choose a branch outside the JWT scope', async () => {
    const { service, goTrue } = setup();

    await expect(
      service.create(owner, {
        recipientName: 'Ana Rider',
        email: 'rider@example.com',
        mobile: '+639171234567',
        branchId: '55555555-5555-4555-8555-555555555555',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(goTrue.inviteUser).not.toHaveBeenCalled();
  });

  it('uses web registration when no invitation redirect is configured', async () => {
    const { service, redirect } = setup({ redirectUrl: null });
    await service.create(owner, {
      recipientName: 'Ana Rider',
      email: 'rider@example.com',
      mobile: '+639171234567',
      branchId,
    });

    expect(new URL(redirect()).origin).toBe('http://localhost:3000');
    expect(new URL(redirect()).pathname).toBe('/delivery-rider-invitation');
    expect(new URL(redirect()).searchParams.get('token')).toBeTruthy();
  });

  it('allows a shared contact number without attaching it to the new Auth identity', async () => {
    const { service, user, goTrue, redirect } = setup();
    const mobile = '+639171234567';
    goTrue.listUsers.mockResolvedValueOnce([{
      ...user,
      id: owner.userId,
      email: 'owner@example.com',
      phone: null,
      app_metadata: { role: 'branch-owner', phone: mobile },
    }]);

    await expect(service.create(owner, {
      recipientName: 'Ana Rider',
      email: 'rider@example.com',
      mobile,
      branchId,
    })).resolves.toMatchObject({ email: 'rider@example.com', mobile, status: 'Pending' });

    const token = new URL(redirect()).searchParams.get('token')!;
    await service.createAccount(token, 'private-password');

    expect(user.app_metadata.phone).toBe(mobile);
    expect(user.phone).toBeNull();
    expect(goTrue.updateUser.mock.lastCall?.[1]).not.toHaveProperty('phone');
    expect(goTrue.updateUser.mock.lastCall?.[1]).not.toHaveProperty('phone_confirm');
  });

  it('resends a registration link after email verification but before password creation', async () => {
    const { service, user, goTrue, redirect } = setup({ redirectUrl: null });
    await service.create(owner, {
      recipientName: 'Ana Rider',
      email: 'rider@example.com',
      mobile: '+639171234567',
      branchId,
    });
    const firstToken = new URL(redirect()).searchParams.get('token');

    await service.resend(owner, user.id);
    const newToken = new URL(redirect()).searchParams.get('token');

    expect(goTrue.sendExistingUserLink).toHaveBeenCalledWith(user.email, redirect());
    expect(newToken).toBeTruthy();
    expect(newToken).not.toBe(firstToken);
    await expect(service.acceptance(newToken!)).resolves.toMatchObject({
      emailVerified: true,
      accountCreated: false,
    });
  });

  it('accepts the web invitation first, then activates after app details confirmation', async () => {
    const { service, user, goTrue, riders, audit, redirect } = setup();

    const created = await service.create(owner, {
      recipientName: 'Ana Rider',
      email: 'RIDER@example.com',
      mobile: '+639171234567',
      branchId,
    });
    const token = new URL(redirect()).searchParams.get('token');
    expect(token).toBeTruthy();
    expect(created).toMatchObject({
      recipientName: 'Ana Rider',
      email: 'rider@example.com',
      mobile: '+639171234567',
      branchId,
      branchName: branch.name,
      status: 'Pending',
    });
    expect(user.app_metadata).toMatchObject({
      role: 'driver',
      status: 'Pending',
      branch_id: branchId,
      branch_ids: [branchId],
      branches: [branch.name],
    });

    await service.createAccount(token!, 'private-password');
    await expect(service.acceptance(token!)).resolves.toMatchObject({
      accountCreated: true,
      mobileVerified: false,
    });
    await service.accept(token!);

    expect(riders.save).not.toHaveBeenCalled();
    expect(user.app_metadata.status).toBe('Pending');
    expect(user.app_metadata.delivery_rider_invitation_accepted_at).toEqual(
      expect.any(String),
    );

    const driver: Principal = {
      userId: user.id,
      role: 'driver',
      status: 'Pending',
      email: user.email,
      displayName: 'Ana Rider',
      branches: [branch.name],
      branchIds: [branchId],
    };
    await expect(service.detailsForSession(driver)).resolves.toMatchObject({
      accountCreated: true,
      mobileVerified: false,
      status: 'Accepted',
    });
    await service.confirmDetailsForSession(driver);
    expect(goTrue.updateUser.mock.calls.every(([, attrs]) => !('phone' in attrs))).toBe(true);
    expect(riders.create).toHaveBeenCalledWith(
      expect.objectContaining({
        authUserId: user.id,
        branchId,
        name: 'Ana Rider',
        plate: 'Unassigned',
        status: 'Offline',
        deletedAt: null,
      }),
    );
    expect(user.app_metadata.status).toBe('Active');
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'delivery-rider-invitation-accepted',
      branchId,
    }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'delivery-rider-account-activated',
      branchId,
    }));
  });

  it('completes web onboarding through the verified pending Delivery Rider session', async () => {
    const { service, user, goTrue, riders } = setup();
    await service.create(owner, {
      recipientName: 'Ana Rider',
      email: 'rider@example.com',
      mobile: '+639171234567',
      branchId,
    });
    const driver: Principal = {
      userId: user.id,
      role: 'driver',
      status: 'Pending',
      email: user.email,
      displayName: 'Ana Rider',
      branches: [branch.name],
      branchIds: [branchId],
    };

    await expect(service.acceptanceForSession(driver)).resolves.toMatchObject({
      invitationId: user.id,
      accountCreated: false,
      mobileVerified: false,
    });
    await service.createAccountForSession(driver, 'private-password');
    await service.acceptForSession(driver);

    expect(riders.save).not.toHaveBeenCalled();
    expect(user.app_metadata.status).toBe('Pending');
    await service.confirmDetailsForSession(driver);

    expect(goTrue.updateUser.mock.calls.every(([, attrs]) => !('phone' in attrs))).toBe(true);
    expect(riders.save).toHaveBeenCalled();
    expect(user.app_metadata.status).toBe('Active');
  });

  it('reissues a revoked invitation through the retained confirmed Auth identity', async () => {
    const { service, user, goTrue, audit, redirect } = setup();
    user.banned_until = '2126-08-30T01:00:00.000Z';
    user.app_metadata = {
      role: 'driver',
      status: 'Revoked',
      branch_id: branchId,
      branch_ids: [branchId],
      branches: [branch.name],
      phone: '+639171234567',
      display_name: 'Old Rider Name',
      delivery_rider_invited_by: owner.userId,
      delivery_rider_invitation_revoked_at: '2026-08-30T02:00:00.000Z',
      delivery_rider_account_created_at: '2026-08-30T01:30:00.000Z',
      delivery_rider_mobile_verified_at: '2026-08-30T01:45:00.000Z',
    };

    const reissued = await service.create(owner, {
      recipientName: 'Ana Rider',
      email: 'RIDER@example.com',
      mobile: '+639171234567',
      branchId,
    });

    const token = new URL(redirect()).searchParams.get('token');
    expect(token).toBeTruthy();
    expect(reissued).toMatchObject({
      invitationId: user.id,
      recipientName: 'Ana Rider',
      email: 'rider@example.com',
      status: 'Pending',
      branchId,
    });
    expect(goTrue.inviteUser).not.toHaveBeenCalled();
    expect(goTrue.sendExistingUserLink).toHaveBeenCalledWith(
      'rider@example.com',
      redirect(),
    );
    expect(goTrue.unbanUser).toHaveBeenCalledWith(user.id);
    expect(user.app_metadata).toMatchObject({
      status: 'Pending',
      display_name: 'Ana Rider',
      phone: '+639171234567',
      branch_id: branchId,
      branch_ids: [branchId],
    });
    expect(user.app_metadata.delivery_rider_invitation_revoked_at).toBeNull();
    expect(user.app_metadata.delivery_rider_account_created_at).toBeNull();
    expect(user.app_metadata.delivery_rider_mobile_verified_at).toBeNull();
    await expect(service.acceptance(token!)).resolves.toMatchObject({
      invitationId: user.id,
      status: 'Pending',
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'delivery-rider-invitation-reissued',
        branchId,
        beforeState: expect.objectContaining({ status: 'Revoked' }),
        afterState: expect.objectContaining({ status: 'Pending' }),
      }),
    );
  });

  it('deactivates an accepted rider while retaining the roster and audit history', async () => {
    const { service, user, goTrue, riders, audit } = setup();
    user.app_metadata = {
      role: 'driver', status: 'Active', branch_id: branchId,
      branch_ids: [branchId], branches: [branch.name],
      delivery_rider_invited_by: owner.userId,
      delivery_rider_invitation_accepted_at: '2026-08-30T02:00:00.000Z',
    };
    jest.spyOn(riders, 'findOne').mockResolvedValueOnce({
      id: '44444444-4444-4444-8444-444444444444', status: 'Available',
    } as Rider);

    const deactivated = await service.deactivate(owner, user.id, 'No longer assigned');

    expect(deactivated.status).toBe('Inactive');
    expect(goTrue.banUser).toHaveBeenCalledWith(user.id);
    expect(user.app_metadata.status).toBe('Inactive');
    expect(riders.update).toHaveBeenCalledWith(
      { id: '44444444-4444-4444-8444-444444444444', branchId },
      expect.objectContaining({ status: 'Offline', operationalLatitude: null }),
    );
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'delivery-rider-account-deactivated',
      branchId,
      reason: 'No longer assigned',
    }));
  });

  it('rejects deactivation during an active delivery', async () => {
    const { service, user, goTrue, riders } = setup();
    user.app_metadata = {
      role: 'driver', status: 'Active', branch_id: branchId,
      branch_ids: [branchId], branches: [branch.name],
      delivery_rider_invited_by: owner.userId,
      delivery_rider_invitation_accepted_at: '2026-08-30T02:00:00.000Z',
    };
    jest.spyOn(riders, 'findOne').mockResolvedValueOnce({ status: 'On Delivery' } as Rider);

    await expect(service.deactivate(owner, user.id, 'No longer assigned')).rejects.toThrow(
      'Complete or reassign the active delivery',
    );
    expect(goTrue.banUser).not.toHaveBeenCalled();
  });

  it('does not let an owner deactivate a rider outside their branch', async () => {
    const { service, user, goTrue } = setup();
    user.app_metadata = {
      role: 'driver', status: 'Active', branch_id: branchId,
      branch_ids: [branchId], branches: [branch.name],
      delivery_rider_invited_by: owner.userId,
      delivery_rider_invitation_accepted_at: '2026-08-30T02:00:00.000Z',
    };

    await expect(service.deactivate(
      { ...owner, branchIds: ['99999999-9999-4999-8999-999999999999'] },
      user.id,
      'No longer assigned',
    )).rejects.toThrow('Delivery Rider invitation not found');
    expect(goTrue.banUser).not.toHaveBeenCalled();
  });

  it('does not reissue an accepted Delivery Rider account', async () => {
    const { service, user, goTrue } = setup();
    user.app_metadata = {
      role: 'driver',
      status: 'Active',
      branch_id: branchId,
      branch_ids: [branchId],
      branches: [branch.name],
      phone: '+639171234567',
      delivery_rider_invited_by: owner.userId,
      delivery_rider_invitation_accepted_at: '2026-08-30T02:00:00.000Z',
    };

    await expect(
      service.create(owner, {
        recipientName: 'Ana Rider',
        email: 'rider@example.com',
        mobile: '+639171234567',
        branchId,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(goTrue.sendExistingUserLink).not.toHaveBeenCalled();
    expect(goTrue.unbanUser).not.toHaveBeenCalled();
  });

  it('reissues a revoked invitation with a shared contact number', async () => {
    const { service, user, goTrue } = setup();
    user.app_metadata = {
      role: 'driver',
      status: 'Revoked',
      branch_id: branchId,
      branch_ids: [branchId],
      branches: [branch.name],
      phone: '+639171234567',
      delivery_rider_invited_by: owner.userId,
      delivery_rider_invitation_revoked_at: '2026-08-30T02:00:00.000Z',
    };
    const otherUser: GoTrueUser = {
      ...user,
      id: '55555555-5555-4555-8555-555555555555',
      email: 'other@example.com',
      phone: '+639181234567',
      app_metadata: { role: 'customer', phone: '+639181234567' },
    };
    goTrue.listUsers.mockResolvedValue([user, otherUser]);

    await expect(
      service.create(owner, {
        recipientName: 'Ana Rider',
        email: 'rider@example.com',
        mobile: '+639181234567',
        branchId,
      }),
    ).resolves.toMatchObject({ mobile: '+639181234567', status: 'Pending' });
    expect(goTrue.sendExistingUserLink).toHaveBeenCalledWith(user.email, expect.any(String));
    expect(goTrue.updateUser.mock.calls.every(([, attrs]) => !('phone' in attrs))).toBe(true);
  });

  it('restores the revoked state if the replacement link cannot be sent', async () => {
    const { service, user, goTrue } = setup();
    user.app_metadata = {
      role: 'driver',
      status: 'Revoked',
      branch_id: branchId,
      branch_ids: [branchId],
      branches: [branch.name],
      phone: '+639171234567',
      delivery_rider_invited_by: owner.userId,
      delivery_rider_invitation_revoked_at: '2026-08-30T02:00:00.000Z',
    };
    goTrue.sendExistingUserLink.mockRejectedValueOnce(new Error('Email unavailable'));

    await expect(
      service.create(owner, {
        recipientName: 'Ana Rider',
        email: 'rider@example.com',
        mobile: '+639171234567',
        branchId,
      }),
    ).rejects.toThrow('Email unavailable');
    expect(user.app_metadata).toMatchObject({
      status: 'Revoked',
      delivery_rider_invitation_revoked_at: '2026-08-30T02:00:00.000Z',
    });
    expect(goTrue.banUser).toHaveBeenCalledWith(user.id);
  });
});
