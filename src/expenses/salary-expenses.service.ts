import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { metadataBranchIds } from '../auth/branch-scope';
import { Principal } from '../auth/principal';
import { GoTrueAdminService, GoTrueUser } from '../users/gotrue-admin.service';
import { CreateSalaryDto } from './dto/create-salary.dto';
import { ListExpensesQuery } from './dto/list-expenses.query';
import { expenseBranch } from './expense-scope';
import { SalaryExpense } from './salary-expense.entity';
import { SalaryExpensesRepository } from './salary-expenses.repository';

export interface SalaryStaff {
  id: string;
  name: string;
  role: 'branch-manager' | 'driver';
}

@Injectable()
export class SalaryExpensesService {
  constructor(
    private readonly rows: SalaryExpensesRepository,
    private readonly auth: GoTrueAdminService,
  ) {}

  list(
    principal: Principal,
    query: ListExpensesQuery,
  ): Promise<SalaryExpense[]> {
    const branchId = this.ownerBranch(principal, query.branchId);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Manila',
      year: 'numeric',
      month: '2-digit',
    }).formatToParts(new Date());
    const month =
      query.month ??
      `${parts.find((p) => p.type === 'year')!.value}-${parts.find((p) => p.type === 'month')!.value}`;
    return this.rows.list(branchId, month);
  }

  async staff(
    principal: Principal,
    query: ListExpensesQuery,
  ): Promise<SalaryStaff[]> {
    const branchId = this.ownerBranch(principal, query.branchId);
    return (await this.auth.listUsers())
      .flatMap((user) => {
        const staff = this.staffInBranch(user, branchId);
        return staff ? [staff] : [];
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async create(
    principal: Principal,
    dto: CreateSalaryDto,
  ): Promise<SalaryExpense> {
    const branchId = this.ownerBranch(principal, dto.branchId);
    if (dto.periodStart > dto.periodEnd)
      throw new BadRequestException(
        'Period end must be on or after period start',
      );
    const hours = [dto.regularHours, dto.overtimeHours];
    const rates = [dto.hourlyRate, dto.overtimeHourlyRate];
    if (
      hours.some((n) => !Number.isFinite(n) || n < 0 || n > 100_000) ||
      rates.some((n) => !Number.isFinite(n) || n < 0 || n > 1_000_000) ||
      dto.hourlyRate <= 0 ||
      (dto.overtimeHours > 0 && dto.overtimeHourlyRate <= 0)
    ) {
      throw new BadRequestException(
        'Enter valid hours and confirmed hourly rates',
      );
    }
    // Integer hundredths avoid binary floating-point drift at the cent boundary.
    const payCents = (h: number, r: number) =>
      Math.round((Math.round(h * 100) * Math.round(r * 100)) / 100);
    const regularCents = payCents(dto.regularHours, dto.hourlyRate);
    const overtimeCents = payCents(dto.overtimeHours, dto.overtimeHourlyRate);
    const totalCents = regularCents + overtimeCents;
    if (totalCents <= 0 || totalCents > 999_999_999_999)
      throw new BadRequestException(
        'Calculated total is outside the allowed range',
      );
    const existing = await this.rows.findRequest(
      branchId,
      principal.userId,
      dto.requestId,
    );
    if (existing) return this.replay(existing, dto);
    const user = await this.auth.getUser(dto.staffId);
    const staff = user && this.staffInBranch(user, branchId);
    if (!staff)
      throw new BadRequestException(
        'Select active staff assigned to this branch',
      );
    try {
      return await this.rows.create({
        branchId,
        staffId: staff.id,
        staffName: staff.name,
        staffRole: staff.role,
        periodStart: dto.periodStart,
        periodEnd: dto.periodEnd,
        regularHours: dto.regularHours,
        hourlyRate: dto.hourlyRate,
        overtimeHours: dto.overtimeHours,
        overtimeHourlyRate: dto.overtimeHourlyRate,
        regularPay: regularCents / 100,
        overtimePay: overtimeCents / 100,
        total: totalCents / 100,
        requestId: dto.requestId,
        recordedBy: principal.userId,
        createdAt: new Date(),
        deletedAt: null,
      });
    } catch (error: unknown) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === '23505'
      ) {
        const replay = await this.rows.findRequest(
          branchId,
          principal.userId,
          dto.requestId,
        );
        if (replay) return this.replay(replay, dto);
      }
      throw error;
    }
  }

  private replay(row: SalaryExpense, dto: CreateSalaryDto): SalaryExpense {
    const fields = [
      'staffId',
      'periodStart',
      'periodEnd',
      'regularHours',
      'hourlyRate',
      'overtimeHours',
      'overtimeHourlyRate',
    ] as const;
    if (fields.some((key) => row[key] !== dto[key]))
      throw new ConflictException(
        'This request already recorded a different salary entry',
      );
    return row;
  }

  private ownerBranch(principal: Principal, branchId?: string): string {
    if (principal.role !== 'branch-owner')
      throw new ForbiddenException('Salary expenses are Branch Owner only');
    return expenseBranch(principal, branchId);
  }

  private staffInBranch(
    user: GoTrueUser,
    branchId: string,
  ): SalaryStaff | null {
    const metadata = user.app_metadata ?? {};
    const role = metadata.role;
    if (
      (role !== 'branch-manager' && role !== 'driver') ||
      metadata.status !== 'Active' ||
      (user.banned_until && new Date(user.banned_until).getTime() > Date.now())
    )
      return null;
    const ids = metadataBranchIds(metadata);
    if (ids.length !== 1 || ids[0] !== branchId) return null;
    const name =
      typeof metadata.display_name === 'string'
        ? metadata.display_name.trim()
        : '';
    return { id: user.id, name: name || user.email || 'Branch staff', role };
  }
}
