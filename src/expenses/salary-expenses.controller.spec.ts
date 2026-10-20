import { INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AuthGuard } from '../auth/auth.guard';
import { ROLES } from '../auth/principal';
import { RolesGuard } from '../auth/roles.guard';
import { SupabaseJwtService } from '../auth/supabase-jwt.service';
import { Branch } from '../branches/branch.entity';
import { GoTrueAdminService } from '../users/gotrue-admin.service';
import { Expense } from './expense.entity';
import { ExpensesController } from './expenses.controller';
import { ExpensesService } from './expenses.service';
import { SalaryExpensesController } from './salary-expenses.controller';
import { SalaryExpensesRepository } from './salary-expenses.repository';
import { SalaryExpensesService } from './salary-expenses.service';

const branchId = '11111111-1111-4111-8111-111111111111';
const outsideId = '22222222-2222-4222-8222-222222222222';
const rows = {
  list: jest.fn().mockResolvedValue([]),
  findRequest: jest.fn().mockResolvedValue(null),
  create: jest
    .fn()
    .mockImplementation((value: unknown) => Promise.resolve(value)),
};
const auth = {
  getUser: jest
    .fn()
    .mockResolvedValue({
      id: '33333333-3333-4333-8333-333333333333',
      app_metadata: {
        role: 'driver',
        status: 'Active',
        branch_ids: [branchId],
        display_name: 'Test Delivery Rider',
      },
    }),
  listUsers: jest.fn().mockResolvedValue([]),
};
const branches = {
  find: jest
    .fn()
    .mockResolvedValue([{ id: branchId, name: 'Owned', ownerId: 'owner' }]),
};
const expenses = {
  find: jest.fn().mockResolvedValue([]),
  findOne: jest.fn().mockResolvedValue(null),
  save: jest.fn(),
};
const jwt = {
  verify: jest
    .fn()
    .mockImplementation((role: string) =>
      Promise.resolve({
        sub: 'owner',
        app_metadata: { role, status: 'Active', branch_ids: [branchId] },
      }),
    ),
};

@Module({
  controllers: [ExpensesController, SalaryExpensesController],
  providers: [
    AuthGuard,
    RolesGuard,
    ExpensesService,
    SalaryExpensesService,
    { provide: SupabaseJwtService, useValue: jwt },
    { provide: GoTrueAdminService, useValue: auth },
    { provide: getRepositoryToken(Branch), useValue: branches },
    { provide: getRepositoryToken(Expense), useValue: expenses },
    { provide: SalaryExpensesRepository, useValue: rows },
  ],
})
class TestModule {}

describe('Salary HTTP authorization and validation', () => {
  let app: INestApplication;
  let url: string;
  let log: jest.SpyInstance;
  beforeAll(async () => {
    log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    app = await NestFactory.create(TestModule, { logger: false });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  });
  afterAll(async () => {
    await app?.close();
    log?.mockRestore();
  });
  const payload = () => ({
    branchId,
    staffId: '33333333-3333-4333-8333-333333333333',
    requestId: '44444444-4444-4444-8444-444444444444',
    periodStart: '2026-10-01',
    periodEnd: '2026-10-31',
    regularHours: 144,
    hourlyRate: 125,
    overtimeHours: 6,
    overtimeHourlyRate: 200,
  });
  const headers = (role: string) => ({
    Authorization: `Bearer ${role}`,
    'Content-Type': 'application/json',
  });

  it.each(ROLES.filter((role) => role !== 'branch-owner'))(
    'denies %s on every compensation route',
    async (role) => {
      expect(
        (
          await fetch(`${url}/salary-expenses?branchId=${branchId}`, {
            headers: headers(role),
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await fetch(`${url}/salary-expenses/staff?branchId=${branchId}`, {
            headers: headers(role),
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await fetch(`${url}/salary-expenses`, {
            method: 'POST',
            headers: headers(role),
            body: JSON.stringify(payload()),
          })
        ).status,
      ).toBe(403);
    },
  );

  it('requires authentication and rejects cross-branch Owner reads/writes', async () => {
    expect(
      (await fetch(`${url}/salary-expenses?branchId=${branchId}`)).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${url}/salary-expenses?branchId=${outsideId}`, {
          headers: headers('branch-owner'),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${url}/salary-expenses`, {
          method: 'POST',
          headers: headers('branch-owner'),
          body: JSON.stringify({ ...payload(), branchId: outsideId }),
        })
      ).status,
    ).toBe(403);
  });

  it('invalidates an Owner token immediately after live ownership changes', async () => {
    branches.find.mockResolvedValueOnce([
      { id: branchId, name: 'Reassigned', ownerId: 'different-owner' },
    ]);
    expect(
      (
        await fetch(`${url}/salary-expenses?branchId=${branchId}`, {
          headers: headers('branch-owner'),
        })
      ).status,
    ).toBe(403);
  });

  it('validates inputs and ignores a forged client total', async () => {
    expect(
      (
        await fetch(`${url}/salary-expenses`, {
          method: 'POST',
          headers: headers('branch-owner'),
          body: JSON.stringify({ ...payload(), regularHours: -1 }),
        })
      ).status,
    ).toBe(400);
    const response = await fetch(`${url}/salary-expenses`, {
      method: 'POST',
      headers: headers('branch-owner'),
      body: JSON.stringify({
        ...payload(),
        total: 1,
        regularPay: 1,
        staffName: 'Forged',
      }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      salary: {
        total: 19200,
        regularPay: 18000,
        overtimePay: 1200,
        staffName: 'Test Delivery Rider',
      },
    });
  });

  it('filters salary records out of ordinary Branch Manager expense queries and prevents writes', async () => {
    const response = await fetch(`${url}/expenses`, {
      headers: headers('branch-manager'),
    });
    expect(response.status).toBe(200);
    expect(expenses.find.mock.calls.at(-1)?.[0]).toMatchObject({
      where: {
        branchId,
        category: expect.objectContaining({
          _type: 'not',
          _value: 'Salary & Wages',
        }),
      },
    });
    const response2 = await fetch(`${url}/expenses`, {
      method: 'POST',
      headers: headers('branch-manager'),
      body: JSON.stringify({
        expenseDate: '2026-10-20',
        category: 'Salary & Wages',
        amount: 10,
        description: 'Salary',
      }),
    });
    expect(response2.status).toBe(403);
    expect(expenses.save).not.toHaveBeenCalled();
  });
});
