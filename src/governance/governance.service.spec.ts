import { ForbiddenException } from '@nestjs/common';
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

  const makeService = (requestOverrides: Partial<Repository<GovernanceRequest>> = {}) => {
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
    const service = new GovernanceService(
      requests,
      { findOne: jest.fn() } as unknown as Repository<Branch>,
      {} as Repository<SlaConfiguration>,
      audit,
      {} as PricesService,
      notifications,
      {} as GoTrueAdminService,
      {} as DataSource,
    );
    return { service, requests, audit, notifications };
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
