import {
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
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
    verificationMode?: 'sms' | 'placeholder';
    nodeEnv?: string;
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
        if (attrs.phone_confirm === true) {
          user.phone_confirmed_at = new Date().toISOString();
        }
      }),
      getUser: jest.fn(async () => user),
      requestPhoneOtp: jest.fn(async () => undefined),
      verifyPhoneOtp: jest.fn(async () => ({ userId: user.id })),
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
      findOne: jest.fn(async () => null),
    } as unknown as Repository<Rider>;
    const audit = {
      record: jest.fn(async () => undefined),
    } as unknown as GovernanceAuditService;
    const config = {
      get: jest.fn((key: string) =>
        key === 'DELIVERY_RIDER_INVITATION_REDIRECT_URL'
          ? 'superkalan://delivery-rider-invitation'
          : key === 'DELIVERY_RIDER_INVITATION_EXPIRY_HOURS'
            ? '48'
            : key === 'DELIVERY_RIDER_MOBILE_VERIFICATION_MODE'
              ? options.verificationMode
              : key === 'NODE_ENV'
                ? options.nodeEnv
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
    return { service, user, goTrue, riders, audit, redirect: () => redirectUrl };
  }

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

  it('accepts the web invitation first, then activates after app mobile verification', async () => {
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
    await expect(service.mobileVerificationForSession(driver)).resolves.toMatchObject({
      accountCreated: true,
      mobileVerified: false,
      status: 'Accepted',
    });
    await service.sendMobileCodeForSession(driver);
    await service.verifyMobileForSession(driver, '123456');

    expect(goTrue.requestPhoneOtp).toHaveBeenCalledWith('+639171234567');
    expect(goTrue.verifyPhoneOtp).toHaveBeenCalledWith('+639171234567', '123456');
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
    await service.sendMobileCodeForSession(driver);
    await service.verifyMobileForSession(driver, '123456');

    expect(goTrue.requestPhoneOtp).toHaveBeenCalledWith('+639171234567');
    expect(riders.save).toHaveBeenCalled();
    expect(user.app_metadata.status).toBe('Active');
  });

  it('uses the explicit development placeholder without claiming provider verification', async () => {
    const { service, user, goTrue, riders, audit, redirect } = setup({
      verificationMode: 'placeholder',
      nodeEnv: 'development',
    });
    await service.create(owner, {
      recipientName: 'Ana Rider',
      email: 'rider@example.com',
      mobile: '+639171234567',
      branchId,
    });
    const token = new URL(redirect()).searchParams.get('token');
    await service.createAccount(token!, 'private-password');
    await service.accept(token!);
    const driver: Principal = {
      userId: user.id,
      role: 'driver',
      status: 'Pending',
      email: user.email,
      displayName: 'Ana Rider',
      branches: [branch.name],
      branchIds: [branchId],
    };

    await expect(service.mobileVerificationForSession(driver)).resolves.toMatchObject({
      verificationMode: 'placeholder',
    });
    await expect(service.sendMobileCodeForSession(driver)).rejects.toBeInstanceOf(
      ConflictException,
    );
    await service.completePlaceholderMobileVerificationForSession(driver);

    expect(goTrue.requestPhoneOtp).not.toHaveBeenCalled();
    expect(goTrue.verifyPhoneOtp).not.toHaveBeenCalled();
    expect(goTrue.updateUser).toHaveBeenCalledWith(
      user.id,
      expect.objectContaining({ phone_confirm: false }),
    );
    expect(user.phone_confirmed_at).toBeUndefined();
    expect(user.app_metadata).toMatchObject({
      status: 'Active',
      delivery_rider_mobile_verification_method: 'placeholder',
    });
    expect(riders.save).toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'delivery-rider-account-activated',
        afterState: expect.objectContaining({
          mobileVerificationMethod: 'placeholder',
        }),
      }),
    );
  });

  it('fails closed when placeholder verification is configured in production', async () => {
    const { service, user, redirect } = setup({
      verificationMode: 'placeholder',
      nodeEnv: 'production',
    });
    await service.create(owner, {
      recipientName: 'Ana Rider',
      email: 'rider@example.com',
      mobile: '+639171234567',
      branchId,
    });
    const token = new URL(redirect()).searchParams.get('token');
    await service.createAccount(token!, 'private-password');
    await service.accept(token!);
    const driver: Principal = {
      userId: user.id,
      role: 'driver',
      status: 'Pending',
      email: user.email,
      displayName: 'Ana Rider',
      branches: [branch.name],
      branchIds: [branchId],
    };

    await expect(service.mobileVerificationForSession(driver)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(
      service.completePlaceholderMobileVerificationForSession(driver),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
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

  it('does not reissue when the submitted mobile belongs to another identity', async () => {
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
    ).rejects.toThrow('An account or invitation with this mobile number already exists');
    expect(goTrue.sendExistingUserLink).not.toHaveBeenCalled();
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
