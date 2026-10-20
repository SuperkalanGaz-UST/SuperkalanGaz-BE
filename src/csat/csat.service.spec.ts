import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';
import { DataSource, In, Repository } from 'typeorm';
import { Principal } from '../auth/principal';
import { Branch } from '../branches/branch.entity';
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
    const branches = {} as jest.Mocked<Repository<Branch>>;
    const dataSource = {} as jest.Mocked<DataSource>;

    return {
      service: new CsatService(ratings, incidents, serviceRequests, riders, branches, dataSource),
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

  it('rejects ratings requested for a stale display-name branch outside the UUID scope', async () => {
    const { service, ratings } = makeService();
    await expect(service.listRatings(
      { ...principal, branches: ['Beta'] },
      { resolution: 'all', branchId: 'branch-uuid-2' },
    )).rejects.toBeInstanceOf(ForbiddenException);
    expect(ratings.find).not.toHaveBeenCalled();
  });

  it('narrows ratings to the selected authorized branch for a multi-branch owner', async () => {
    const { service, ratings } = makeService();
    ratings.find.mockResolvedValue([]);
    await service.listRatings(
      { ...principal, branchIds: ['branch-uuid-1', 'branch-uuid-2'] },
      { resolution: 'all', branchId: 'branch-uuid-2' },
    );
    expect(ratings.find).toHaveBeenCalledWith(expect.objectContaining({
      where: { branchId: In(['branch-uuid-2']) },
    }));
  });

  it('requires a selection before loading ratings or summaries for a multi-branch owner', async () => {
    const { service, ratings } = makeService();
    const owner = { ...principal, branchIds: ['branch-uuid-1', 'branch-uuid-2'] };
    await expect(service.listRatings(owner, { resolution: 'all' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.getSummary(owner)).rejects.toBeInstanceOf(ForbiddenException);
    expect(ratings.find).not.toHaveBeenCalled();
  });

  it('rejects a summary for a branch outside the UUID scope before querying ratings', async () => {
    const { service } = makeService();
    await expect(service.getSummary(principal, 'branch-uuid-2')).rejects.toBeInstanceOf(ForbiddenException);
  });
});
