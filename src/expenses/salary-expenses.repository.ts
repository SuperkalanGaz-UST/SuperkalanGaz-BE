import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, IsNull, Repository } from 'typeorm';
import { SalaryExpense } from './salary-expense.entity';

@Injectable()
export class SalaryExpensesRepository {
  constructor(
    @InjectRepository(SalaryExpense)
    private readonly rows: Repository<SalaryExpense>,
  ) {}

  list(branchId: string, month: string): Promise<SalaryExpense[]> {
    const [year, monthNumber] = month.split('-').map(Number);
    const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
    return this.rows.find({
      where: {
        branchId,
        periodEnd: Between(`${month}-01`, `${month}-${lastDay}`),
        deletedAt: IsNull(),
      },
      order: { periodEnd: 'DESC', createdAt: 'DESC' },
    });
  }

  findRequest(
    branchId: string,
    recordedBy: string,
    requestId: string,
  ): Promise<SalaryExpense | null> {
    return this.rows.findOne({
      where: { branchId, recordedBy, requestId, deletedAt: IsNull() },
    });
  }

  create(value: Omit<SalaryExpense, 'id'>): Promise<SalaryExpense> {
    return this.rows.save(this.rows.create(value));
  }
}
