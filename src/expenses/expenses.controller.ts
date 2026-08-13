import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { Principal } from '../auth/principal';
import { CurrentPrincipal, Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { CreateExpenseDto } from './dto/create-expense.dto';
import { ListExpensesQuery } from './dto/list-expenses.query';
import { UpdateExpenseDto } from './dto/update-expense.dto';
import { Expense } from './expense.entity';
import { ExpensesService } from './expenses.service';

@Controller('expenses')
@UseGuards(AuthGuard, RolesGuard)
@Roles('branch-owner', 'branch-manager')
export class ExpensesController {
  constructor(private readonly expenses: ExpensesService) {}

  @Get()
  async list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListExpensesQuery,
  ): Promise<{ expenses: ReturnType<ExpensesController['toRow']>[] }> {
    const rows = await this.expenses.list(principal, query);
    return { expenses: rows.map((row) => this.toRow(row)) };
  }

  @Post()
  @Roles('branch-manager')
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: CreateExpenseDto,
  ): Promise<{ expense: ReturnType<ExpensesController['toRow']> }> {
    return { expense: this.toRow(await this.expenses.create(principal, dto)) };
  }

  @Patch(':id')
  @Roles('branch-manager')
  async update(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateExpenseDto,
  ): Promise<{ expense: ReturnType<ExpensesController['toRow']> }> {
    return { expense: this.toRow(await this.expenses.update(principal, id, dto)) };
  }

  private toRow(expense: Expense) {
    return {
      id: expense.id,
      branch_id: expense.branchId,
      expense_date: expense.expenseDate,
      reference_no: expense.referenceNo,
      category: expense.category,
      description: expense.description,
      amount: expense.amount,
      receipt_name: expense.receiptName,
      recorded_by: expense.recordedBy,
      created_at: expense.createdAt,
      updated_at: expense.updatedAt,
    };
  }
}
