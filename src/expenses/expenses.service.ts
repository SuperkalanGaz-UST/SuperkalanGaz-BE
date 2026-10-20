import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, IsNull, Not, Repository } from 'typeorm';
import { Principal } from '../auth/principal';
import { CreateExpenseDto } from './dto/create-expense.dto';
import { ListExpensesQuery } from './dto/list-expenses.query';
import { UpdateExpenseDto } from './dto/update-expense.dto';
import { Expense } from './expense.entity';
import { expenseBranch } from './expense-scope';

const BUSINESS_TIME_ZONE = 'Asia/Manila';

/**
 * Branch operational expense persistence. Branch scope comes exclusively from
 * the verified principal. The server also owns the current-month rule, so a
 * modified browser request cannot backdate or future-date a write.
 */
@Injectable()
export class ExpensesService {
  constructor(
    @InjectRepository(Expense)
    private readonly expenses: Repository<Expense>,
  ) {}

  async list(principal: Principal, query: ListExpensesQuery): Promise<Expense[]> {
    const branchId = expenseBranch(principal, query.branchId);
    const month = query.month ?? this.currentBusinessMonth();
    const { firstDate, lastDate } = this.monthBounds(month);

    return this.expenses.find({
      where: {
        branchId,
        ...(principal.role === 'branch-owner' ? {} : { category: Not('Salary & Wages') }),
        expenseDate: Between(firstDate, lastDate),
        deletedAt: IsNull(),
      },
      order: { expenseDate: 'DESC', createdAt: 'DESC' },
    });
  }

  async create(principal: Principal, dto: CreateExpenseDto): Promise<Expense> {
    this.assertOperationalWrite(principal, dto.category);
    const branchId = expenseBranch(principal);
    this.assertCurrentMonth(dto.expenseDate);
    const description = dto.description.trim();
    if (!description) throw new BadRequestException('Description is required');

    const now = new Date();
    const expense = this.expenses.create({
      branchId,
      expenseDate: dto.expenseDate,
      referenceNo: dto.reference?.trim() || null,
      category: dto.category,
      description,
      amount: dto.amount,
      receiptName: dto.receiptName?.trim() || null,
      recordedBy: principal.userId,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });

    return this.expenses.save(expense);
  }

  async update(
    principal: Principal,
    id: string,
    dto: UpdateExpenseDto,
  ): Promise<Expense> {
    this.assertOperationalWrite(principal, dto.category);
    const branchId = expenseBranch(principal);
    const suppliedFields = Object.values(dto).filter((value) => value !== undefined);
    if (suppliedFields.length === 0) {
      throw new BadRequestException('Provide at least one expense field to update');
    }

    const expense = await this.expenses.findOne({
      where: { id, branchId, category: Not('Salary & Wages'), deletedAt: IsNull() },
    });
    if (!expense || expense.category === 'Salary & Wages') throw new NotFoundException('Expense not found');

    // Closed months remain immutable even if a caller replays an old edit request.
    this.assertCurrentMonth(expense.expenseDate);
    if (dto.expenseDate !== undefined) {
      this.assertCurrentMonth(dto.expenseDate);
      expense.expenseDate = dto.expenseDate;
    }
    if (dto.category !== undefined) expense.category = dto.category;
    if (dto.amount !== undefined) expense.amount = dto.amount;
    if (dto.reference !== undefined) expense.referenceNo = dto.reference?.trim() || null;
    if (dto.description !== undefined) {
      const description = dto.description.trim();
      if (!description) throw new BadRequestException('Description is required');
      expense.description = description;
    }
    if (dto.receiptName !== undefined) expense.receiptName = dto.receiptName?.trim() || null;
    expense.updatedAt = new Date();

    return this.expenses.save(expense);
  }

  private assertCurrentMonth(expenseDate: string): void {
    if (!expenseDate.startsWith(`${this.currentBusinessMonth()}-`)) {
      throw new BadRequestException('Expenses can only be logged or edited in the current month');
    }
  }

  private currentBusinessMonth(now = new Date()): string {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: BUSINESS_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
    }).formatToParts(now);
    const year = parts.find((part) => part.type === 'year')?.value;
    const month = parts.find((part) => part.type === 'month')?.value;
    if (!year || !month) throw new Error('Could not resolve the business month');
    return `${year}-${month}`;
  }

  private monthBounds(month: string): { firstDate: string; lastDate: string } {
    const [year, monthNumber] = month.split('-').map(Number);
    const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
    return {
      firstDate: `${month}-01`,
      lastDate: `${month}-${String(lastDay).padStart(2, '0')}`,
    };
  }

  private assertOperationalWrite(principal: Principal, category?: string): void {
    if (principal.role !== 'branch-manager' || category === 'Salary & Wages') {
      throw new ForbiddenException('Salary expenses can only be recorded by the Branch Owner');
    }
  }
}
