import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { Expense } from './expense.entity';
import { ExpensesController } from './expenses.controller';
import { ExpensesService } from './expenses.service';
import { SalaryExpense } from './salary-expense.entity';
import { SalaryExpensesController } from './salary-expenses.controller';
import { SalaryExpensesService } from './salary-expenses.service';
import { SalaryExpensesRepository } from './salary-expenses.repository';

@Module({
  imports: [TypeOrmModule.forFeature([Expense, SalaryExpense]), AuthModule],
  controllers: [ExpensesController, SalaryExpensesController],
  providers: [ExpensesService, SalaryExpensesService, SalaryExpensesRepository],
})
export class ExpensesModule {}
