import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { Principal } from '../auth/principal';
import { Expense } from './expense.entity';
import { ExpensesService } from './expenses.service';

describe('ExpensesService', () => {
  const makeRepo = () =>
    ({
      create: jest.fn((value: Partial<Expense>) => value as Expense),
      save: jest.fn((value: Expense) => Promise.resolve(value)),
      find: jest.fn(() => Promise.resolve([])),
      findOne: jest.fn(() => Promise.resolve(null)),
    }) as unknown as jest.Mocked<Repository<Expense>>;

  const principal = (branchIds: string[] = ['branch-1']): Principal => ({
    userId: 'manager-1',
    role: 'branch-manager',
    branches: ['Quezon City Branch'],
    branchIds,
  });

  const currentDate = (): string => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Manila',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const value = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === type)?.value ?? '';
    return `${value('year')}-${value('month')}-${value('day')}`;
  };

  const dto = () => ({
    expenseDate: currentDate(),
    category: 'Utilities' as const,
    amount: 1450,
    reference: '  OR-123  ',
    description: '  Water bill  ',
    receiptName: '  bill.pdf  ',
  });

  it('creates under the caller branch with a server-owned actor', async () => {
    const repo = makeRepo();
    const service = new ExpensesService(repo);

    const result = await service.create(principal(), dto());

    expect(result.branchId).toBe('branch-1');
    expect(result.recordedBy).toBe('manager-1');
    expect(result.referenceNo).toBe('OR-123');
    expect(result.description).toBe('Water bill');
    expect(result.receiptName).toBe('bill.pdf');
    expect(repo.save).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the caller has no active branch', async () => {
    const repo = makeRepo();
    const service = new ExpensesService(repo);

    await expect(service.create(principal([]), dto())).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.list(principal([]), {})).rejects.toBeInstanceOf(ForbiddenException);
    expect(repo.save).not.toHaveBeenCalled();
    expect(repo.find).not.toHaveBeenCalled();
  });

  it('rejects writes outside the current Philippine calendar month', async () => {
    const repo = makeRepo();
    const service = new ExpensesService(repo);

    await expect(
      service.create(principal(), { ...dto(), expenseDate: '2000-01-01' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('lists only live rows in the caller branch and requested month', async () => {
    const repo = makeRepo();
    const service = new ExpensesService(repo);

    await service.list(principal(['branch-1', 'branch-2']), { month: '2026-07' });

    const where = repo.find.mock.calls[0][0]?.where as Record<string, unknown>;
    expect(where).toHaveProperty('branchId');
    expect(where).toHaveProperty('expenseDate');
    expect(where).toHaveProperty('deletedAt');
    expect(repo.find.mock.calls[0][0]?.order).toEqual({ expenseDate: 'DESC', createdAt: 'DESC' });
  });

  it('returns 404 instead of leaking an out-of-branch expense', async () => {
    const repo = makeRepo();
    const service = new ExpensesService(repo);

    await expect(
      service.update(principal(), 'outside-scope', { description: 'Changed' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('keeps closed-month rows immutable', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue({
      id: 'expense-1',
      branchId: 'branch-1',
      expenseDate: '2000-01-01',
      deletedAt: null,
    } as Expense);
    const service = new ExpensesService(repo);

    await expect(
      service.update(principal(), 'expense-1', { description: 'Changed' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.save).not.toHaveBeenCalled();
  });
});
