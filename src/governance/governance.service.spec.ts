import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, Repository } from 'typeorm';
import { Principal } from '../auth/principal';
import { Branch } from '../branches/branch.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { PricesService } from '../prices/prices.service';
import { CYLINDER_SIZES } from '../prices/dto/update-prices.dto';
import { SlaConfiguration } from '../service-requests/sla-configuration.entity';
import { GoTrueAdminService } from '../users/gotrue-admin.service';
import { GovernanceAuditService } from './governance-audit.service';
import { GovernanceRequest } from './governance-request.entity';
import { GovernanceService } from './governance.service';

describe('GovernanceService', () => {
  const franchiseAdmin: Principal = {
    userId: '11111111-1111-4111-8111-111111111111',
    role: 'franchise-admin',
    displayName: 'Maria Santos',
    branches: [],
    branchIds: [],
  };
  const superAdmin: Principal = {
    userId: '22222222-2222-4222-8222-222222222222',
    role: 'super-admin',
    displayName: 'Elena Garcia',
    branches: [],
    branchIds: [],
  };

  const makeService = (
    requestOverrides: Partial<Repository<GovernanceRequest>> = {},
    goTrueOverrides: Partial<GoTrueAdminService> = {},
  ) => {
    const requests = {
      create: jest.fn((value: GovernanceRequest) => value),
      save: jest.fn((value: GovernanceRequest) =>
        Promise.resolve(Object.assign(value, { id: value.id ?? '33333333-3333-4333-8333-333333333333' })),
      ),
      findOne: jest.fn(),
      ...requestOverrides,
    } as unknown as jest.Mocked<Repository<GovernanceRequest>>;
    const audit = {
      record: jest.fn(() => Promise.resolve()),
    } as unknown as jest.Mocked<GovernanceAuditService>;
    const notifications = {
      publishForRole: jest.fn(() => Promise.resolve()),
    } as unknown as jest.Mocked<NotificationsService>;
    const goTrue = {
      ...goTrueOverrides,
    } as unknown as jest.Mocked<GoTrueAdminService>;
    const service = new GovernanceService(
      requests,
      { findOne: jest.fn() } as unknown as Repository<Branch>,
      {} as Repository<SlaConfiguration>,
      audit,
      {} as PricesService,
      notifications,
      goTrue,
      {} as DataSource,
      {
        get: jest.fn((key: string) =>
          key === 'WEB_ORIGIN' ? 'http://localhost:3000' : undefined,
        ),
      } as unknown as ConfigService,
    );
    return { service, requests, audit, notifications, goTrue };
  };

  it('stores a complete price proposal without applying prices before approval', async () => {
    const { service, requests, audit, notifications } = makeService();
    const result = await service.submit(franchiseAdmin, {
      type: 'price-configuration',
      title: 'System-wide LPG price configuration',
      reason: 'Supplier acquisition cost changed.',
      payload: {
        prices: CYLINDER_SIZES.map((cylinderSize, index) => ({
          cylinderSize,
          unitPrice: 300 + index * 100,
        })),
      },
    });

    expect(result.status).toBe('pending');
    expect(result.requestedBy).toBe(franchiseAdmin.userId);
    expect(requests.save).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'governance-request-submitted',
        governanceRequestId: result.id,
      }),
    );
    expect(notifications.publishForRole).toHaveBeenCalledWith(
      expect.objectContaining({ audienceRole: 'super-admin' }),
    );
  });

  it('rejects the retired Franchise Administrator account request path', async () => {
    const { service, requests } = makeService();

    await expect(
      service.submit(franchiseAdmin, {
        type: 'franchise-admin-account',
        title: 'Create Franchise Administrator',
        reason: 'A new administrator is required.',
        payload: {
          name: 'Ana Reyes',
          email: 'ana.reyes@example.com',
        },
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(requests.save).not.toHaveBeenCalled();
  });

  it('sends a role-locked Franchise Administrator invitation without creating a password', async () => {
    const sentAt = new Date().toISOString();
    const invited = {
      id: '44444444-4444-4444-8444-444444444444',
      email: 'ana.reyes@example.com',
      app_metadata: {},
      user_metadata: {},
      banned_until: null,
      created_at: sentAt,
      invited_at: sentAt,
      confirmation_sent_at: sentAt,
      confirmed_at: null,
      email_confirmed_at: null,
    };
    const { service, goTrue, audit } = makeService({}, {
      findByEmail: jest.fn(() => Promise.resolve(null)),
      inviteUser: jest.fn(() => Promise.resolve(invited)),
      updateUser: jest.fn(() => Promise.resolve()),
    });

    const invitation = await service.inviteFranchiseAdministrator(superAdmin, {
      name: 'Ana Reyes',
      email: 'ANA.REYES@EXAMPLE.COM',
    });

    expect(goTrue.inviteUser).toHaveBeenCalledWith(
      'ana.reyes@example.com',
      'Ana Reyes',
      'http://localhost:3000/?invitation=franchise-admin',
    );
    expect(goTrue.updateUser).toHaveBeenCalledWith(
      invited.id,
      expect.objectContaining({
        app_metadata: expect.objectContaining({
          role: 'franchise-admin',
          status: 'Pending',
          invited_by: superAdmin.userId,
        }),
      }),
    );
    expect(JSON.stringify(goTrue.updateUser.mock.calls)).not.toContain('password');
    expect(invitation.status).toBe('Pending');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'franchise-admin-invitation-sent' }),
    );
  });

  it('activates a verified pending invitation and records acceptance', async () => {
    const pendingPrincipal: Principal = {
      ...franchiseAdmin,
      userId: '44444444-4444-4444-8444-444444444444',
      status: 'Pending',
    };
    const { service, goTrue, audit, notifications } = makeService({}, {
      getUser: jest.fn(() => Promise.resolve({
        id: pendingPrincipal.userId,
        email: 'ana.reyes@example.com',
        app_metadata: {
          role: 'franchise-admin',
          status: 'Pending',
          display_name: 'Ana Reyes',
          invited_by: superAdmin.userId,
        },
        user_metadata: {},
        banned_until: null,
        created_at: '2026-08-25T01:00:00.000Z',
        confirmed_at: '2026-08-25T01:30:00.000Z',
      })),
      updateUser: jest.fn(() => Promise.resolve()),
    });

    await service.acceptFranchiseAdministratorInvitation(pendingPrincipal);

    expect(goTrue.updateUser).toHaveBeenCalledWith(
      pendingPrincipal.userId,
      expect.objectContaining({
        app_metadata: expect.objectContaining({ status: 'Active' }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'franchise-admin-invitation-accepted' }),
    );
    expect(notifications.publishForRole).toHaveBeenCalledWith(
      expect.objectContaining({ audienceRole: 'super-admin' }),
    );
  });

  it('rejects self-approval before claiming or applying a request', async () => {
    const request = Object.assign(new GovernanceRequest(), {
      id: '33333333-3333-4333-8333-333333333333',
      requestedBy: superAdmin.userId,
      status: 'pending',
      deletedAt: null,
    });
    const findOne = jest.fn(() => Promise.resolve(request));
    const { service } = makeService({ findOne } as Partial<Repository<GovernanceRequest>>);

    await expect(
      service.decide(superAdmin, request.id, {
        decision: 'approve',
        reason: 'Approved after review.',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('prevents approval of a legacy Franchise Administrator account request', async () => {
    const request = Object.assign(new GovernanceRequest(), {
      id: '33333333-3333-4333-8333-333333333333',
      type: 'franchise-admin-account',
      requestedBy: franchiseAdmin.userId,
      status: 'pending',
      deletedAt: null,
    });
    const findOne = jest.fn(() => Promise.resolve(request));
    const { service } = makeService({ findOne } as Partial<Repository<GovernanceRequest>>);

    await expect(
      service.decide(superAdmin, request.id, {
        decision: 'approve',
        reason: 'Use the invitation workflow instead.',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
