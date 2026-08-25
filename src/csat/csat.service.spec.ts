import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';
import { DataSource, Repository } from 'typeorm';
import { Principal } from '../auth/principal';
import { Rider } from '../fleet/rider.entity';
import { ServiceRequest } from '../service-requests/service-request.entity';
import { CsatService } from './csat.service';
import { Incident } from './incident.entity';
import { Rating } from './rating.entity';

describe('CsatService branch reports', () => {
  const principal: Principal = {
    userId: 'owner-1',
    role: 'branch-owner',
    branches: ['Alpha'],
    branchIds: ['branch-uuid-1'],
  };

  const makeService = () => {
    const ratings = {
      find: jest.fn(() =>
        Promise.resolve([
          { id: 'rating-1', stars: 5 },
          { id: 'rating-2', stars: 4 },
        ] as Rating[]),
      ),
    } as unknown as jest.Mocked<Repository<Rating>>;
    const incidents = {
      count: jest.fn(() => Promise.resolve(1)),
    } as unknown as jest.Mocked<Repository<Incident>>;
    const serviceRequests = {
      find: jest.fn(() =>
        Promise.resolve([
          { id: 'delivery-1' },
          { id: 'delivery-2' },
          { id: 'delivery-3' },
          { id: 'delivery-4' },
        ] as ServiceRequest[]),
      ),
    } as unknown as jest.Mocked<Repository<ServiceRequest>>;
    const riders = {} as jest.Mocked<Repository<Rider>>;
    const dataSource = {} as jest.Mocked<DataSource>;

    return {
      service: new CsatService(ratings, incidents, serviceRequests, riders, dataSource),
      ratings,
      incidents,
      serviceRequests,
    };
  };

  it('calculates rating distribution and response rate from branch deliveries', async () => {
    const { service } = makeService();

    const report = await service.getBranchReport(principal, {
      from: '2026-05-01',
      to: '2026-05-31',
      branchId: 'branch-uuid-1',
    });

    expect(report.averageStars).toBe(4.5);
    expect(report.totalResponses).toBe(2);
    expect(report.deliveredRequests).toBe(4);
    expect(report.responseRate).toBe(50);
    expect(report.incidentsRaised).toBe(1);
    expect(report.ratingDistribution).toEqual({ 1: 0, 2: 0, 3: 0, 4: 1, 5: 1 });
  });

  it('rejects a requested branch outside the JWT-derived scope', async () => {
    const { service, serviceRequests } = makeService();

    await expect(
      service.getBranchReport(principal, {
        from: '2026-05-01',
        to: '2026-05-31',
        branchId: 'branch-uuid-2',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(serviceRequests.find).not.toHaveBeenCalled();
  });
});
