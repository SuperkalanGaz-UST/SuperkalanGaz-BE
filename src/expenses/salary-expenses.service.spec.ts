import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { Principal, ROLES } from '../auth/principal';
import { GoTrueAdminService, GoTrueUser } from '../users/gotrue-admin.service';
import { CreateSalaryDto } from './dto/create-salary.dto';
import { SalaryExpense } from './salary-expense.entity';
import { SalaryExpensesRepository } from './salary-expenses.repository';
import { SalaryExpensesService } from './salary-expenses.service';

const branchId = '00000000-0000-4000-8000-000000000001';
const staffId = '00000000-0000-4000-8000-000000000002';
const owner: Principal = {
  userId: 'owner',
  role: 'branch-owner',
  branchIds: [branchId, 'second-branch'],
  branches: ['Branch', 'Other'],
};
const payload = (): CreateSalaryDto => ({
  branchId,
  staffId,
  requestId: '00000000-0000-4000-8000-000000000003',
  periodStart: '2026-10-01',
  periodEnd: '2026-10-31',
  regularHours: 144,
  hourlyRate: 125,
  overtimeHours: 6,
  overtimeHourlyRate: 200,
});
const person = (metadata: Record<string, unknown> = {}): GoTrueUser => ({
  id: staffId,
  email: 'test@example.invalid',
  app_metadata: {
    role: 'driver',
    status: 'Active',
    branch_ids: [branchId],
    display_name: 'Test Delivery Rider',
    ...metadata,
  },
  user_metadata: {},
  banned_until: null,
  created_at: '2026-10-01',
});

function setup() {
  const rows = {
    list: jest.fn().mockResolvedValue([]),
    findRequest: jest.fn().mockResolvedValue(null),
    create: jest
      .fn()
      .mockImplementation((value: Omit<SalaryExpense, 'id'>) =>
        Promise.resolve({ ...value, id: 'saved' }),
      ),
  };
  const auth = {
    listUsers: jest.fn().mockResolvedValue([person()]),
    getUser: jest.fn().mockResolvedValue(person()),
  };
  const service = new SalaryExpensesService(
    rows as unknown as SalaryExpensesRepository,
    auth as unknown as GoTrueAdminService,
  );
  return { service, rows, auth };
}

describe('Owner salary expenses', () => {
  it.each(ROLES.filter((role) => role !== 'branch-owner'))(
    'denies %s before querying any compensation or staff',
    async (role) => {
      const { service, rows, auth } = setup();
      const caller = { ...owner, role };
      expect(() => service.list(caller, { branchId })).toThrow(
        ForbiddenException,
      );
      await expect(service.staff(caller, { branchId })).rejects.toThrow(
        ForbiddenException,
      );
      await expect(service.create(caller, payload())).rejects.toThrow(
        ForbiddenException,
      );
      expect(rows.list).not.toHaveBeenCalled();
      expect(rows.findRequest).not.toHaveBeenCalled();
      expect(auth.listUsers).not.toHaveBeenCalled();
      expect(auth.getUser).not.toHaveBeenCalled();
    },
  );

  it('requires a selected authorized branch without falling back to the first assignment', async () => {
    const { service, rows } = setup();
    expect(() => service.list(owner, {})).toThrow(ForbiddenException);
    expect(() => service.list(owner, { branchId: 'outside' })).toThrow(
      ForbiddenException,
    );
    await expect(
      service.create(owner, { ...payload(), branchId: 'outside' }),
    ).rejects.toThrow(ForbiddenException);
    expect(rows.list).not.toHaveBeenCalled();
    await service.list(owner, { branchId: 'second-branch', month: '2026-10' });
    expect(rows.list).toHaveBeenCalledWith('second-branch', '2026-10');
  });

  it('computes authoritative rounded amounts and snapshots only verified staff identity', async () => {
    const { service, rows } = setup();
    const result = await service.create(owner, {
      ...payload(),
      regularPay: 1,
      total: 1,
    } as CreateSalaryDto);
    expect(result).toMatchObject({
      branchId,
      staffId,
      staffName: 'Test Delivery Rider',
      staffRole: 'driver',
      regularPay: 18000,
      overtimePay: 1200,
      total: 19200,
      recordedBy: owner.userId,
    });
    expect(rows.create).toHaveBeenCalledTimes(1);
    const rounded = await service.create(owner, {
      ...payload(),
      regularHours: 1.01,
      hourlyRate: 1.5,
      overtimeHours: 0,
      overtimeHourlyRate: 0,
    });
    expect(rounded.regularPay).toBe(1.52);
    expect(rounded.total).toBe(1.52);
  });

  it.each([
    { role: 'customer' },
    { branch_ids: ['00000000-0000-4000-8000-000000000009'] },
    { branch_ids: [branchId, '00000000-0000-4000-8000-000000000009'] },
    { status: 'Inactive' },
    { status: 'Pending' },
  ])('rejects mismatched or inactive staff: %j', async (metadata) => {
    const { service, auth, rows } = setup();
    auth.getUser.mockResolvedValue(person(metadata));
    await expect(service.create(owner, payload())).rejects.toThrow(
      BadRequestException,
    );
    expect(rows.create).not.toHaveBeenCalled();
  });

  it('filters the staff picker by protected branch, role, status, and ban state', async () => {
    const { service, auth } = setup();
    auth.listUsers.mockResolvedValue([
      person(),
      person({ role: 'customer' }),
      person({ branch_ids: ['outside'] }),
      person({ status: 'Pending' }),
      { ...person(), banned_until: '2999-01-01' },
    ]);
    expect(await service.staff(owner, { branchId })).toEqual([
      { id: staffId, name: 'Test Delivery Rider', role: 'driver' },
    ]);
  });

  it.each([
    { periodEnd: '2026-09-30' },
    { regularHours: -1 },
    { hourlyRate: 0 },
    { overtimeHourlyRate: 0 },
    { regularHours: 0, overtimeHours: 0 },
    { regularHours: 100000, hourlyRate: 1000000 },
  ])('rejects invalid periods or pay before saving: %j', async (change) => {
    const { service, rows } = setup();
    await expect(
      service.create(owner, { ...payload(), ...change }),
    ).rejects.toThrow(BadRequestException);
    expect(rows.create).not.toHaveBeenCalled();
  });

  it('returns the original expense when the same request is retried, and rejects changed payloads', async () => {
    const { service, rows, auth } = setup();
    const original = await service.create(owner, payload());
    rows.findRequest.mockResolvedValue(original);
    expect(await service.create(owner, payload())).toBe(original);
    expect(rows.create).toHaveBeenCalledTimes(1);
    expect(auth.getUser).toHaveBeenCalledTimes(1);
    await expect(
      service.create(owner, { ...payload(), regularHours: 145 }),
    ).rejects.toThrow(ConflictException);
  });

  it('handles concurrent retries using the database uniqueness boundary', async () => {
    const { service, rows } = setup();
    const original = await service.create(owner, payload());
    rows.findRequest
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(original);
    rows.create.mockRejectedValueOnce({ code: '23505' });
    expect(await service.create(owner, payload())).toBe(original);
  });

  it('validates the DTO at the HTTP input boundary', async () => {
    const invalid = plainToInstance(CreateSalaryDto, {
      ...payload(),
      staffId: 'not-a-uuid',
      periodStart: '2026-02-31',
      hourlyRate: 1.001,
      overtimeHours: -1,
    });
    const properties = (await validate(invalid)).map((error) => error.property);
    expect(properties).toEqual(
      expect.arrayContaining([
        'staffId',
        'periodStart',
        'hourlyRate',
        'overtimeHours',
      ]),
    );
  });
});
