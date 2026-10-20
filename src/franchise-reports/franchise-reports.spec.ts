import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DataSource } from 'typeorm';
import { Principal, ROLES, REQUEST_PRINCIPAL } from '../auth/principal';
import { RolesGuard } from '../auth/roles.guard';
import { FranchiseReportsController } from './franchise-reports.controller';
import { FranchiseReportsQuery } from './franchise-reports.query';
import { FranchiseReportsService } from './franchise-reports.service';
import { ExecutionContext } from '@nestjs/common';

const principal = (role: Principal['role']): Principal => ({ userId: 'test-user', role, branches: [], branchIds: [] });

describe('Franchise reports access', () => {
  const handlers = ['orders', 'customers', 'customer', 'csat', 'ratings', 'incidents'] as const;
  const guard = new RolesGuard(new Reflector());

  for (const handler of handlers) {
    for (const role of ROLES) {
      it(`${handler}: ${role} is ${role === 'franchise-admin' ? 'allowed' : 'denied'}`, () => {
        const context = {
          getHandler: () => FranchiseReportsController.prototype[handler],
          getClass: () => FranchiseReportsController,
          switchToHttp: () => ({ getRequest: () => ({ [REQUEST_PRINCIPAL]: principal(role) }) }),
        } as unknown as ExecutionContext;
        if (role === 'franchise-admin') expect(guard.canActivate(context)).toBe(true);
        else expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
      });
    }
  }

  it('rejects direct service calls from operational roles before querying', async () => {
    const query = jest.fn();
    const service = new FranchiseReportsService({ query } as unknown as DataSource);
    const q = new FranchiseReportsQuery();
    for (const role of ROLES.filter(r => r !== 'franchise-admin')) {
      const p = principal(role);
      await expect(service.customers(p, q)).rejects.toThrow(ForbiddenException);
      await expect(service.customer(p, 'test')).rejects.toThrow(ForbiddenException);
      await expect(service.orders(p, q)).rejects.toThrow(ForbiddenException);
      await expect(service.csat(p, q)).rejects.toThrow(ForbiddenException);
      await expect(service.ratings(p, q)).rejects.toThrow(ForbiddenException);
      await expect(service.incidents(p, q)).rejects.toThrow(ForbiddenException);
    }
    expect(query).not.toHaveBeenCalled();
  });

  it('passes user filters as parameters, never as executable SQL', async () => {
    const query = jest.fn().mockResolvedValue([{ rows: [], total: 0 }]);
    const service = new FranchiseReportsService({ query } as unknown as DataSource);
    const q = Object.assign(new FranchiseReportsQuery(), { search: "'; DROP TABLE cim.customers; --", page: 2, limit: 10 });
    await service.customers(principal('franchise-admin'), q);
    const [sql, parameters] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toContain(q.search);
    expect(parameters).toEqual([null, `%${q.search}%`, null, null, 10, 10]);
  });
});

describe('Franchise report query validation', () => {
  it.each([
    { branchId: 'not-a-uuid' }, { page: 0 }, { page: 1.5 }, { limit: 101 }, { limit: -1 },
    { stars: 6 }, { status: 'invented' }, { incidentStatus: 'invented' },
  ])('rejects invalid filter %j', async filters => {
    expect((await validate(plainToInstance(FranchiseReportsQuery, filters))).length).toBeGreaterThan(0);
  });

  it('transforms and accepts a valid bounded page', async () => {
    const q = plainToInstance(FranchiseReportsQuery, { page: '2', limit: '25', stars: '4' });
    expect(await validate(q)).toEqual([]);
    expect(q.page).toBe(2);
    expect(q.limit).toBe(25);
  });
});
