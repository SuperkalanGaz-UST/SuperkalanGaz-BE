import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { Principal } from '../auth/principal';
import { CurrentPrincipal, Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { CreateSalaryDto } from './dto/create-salary.dto';
import { ListExpensesQuery } from './dto/list-expenses.query';
import { SalaryExpensesService } from './salary-expenses.service';

@Controller('salary-expenses')
@UseGuards(AuthGuard, RolesGuard)
@Roles('branch-owner')
export class SalaryExpensesController {
  constructor(private readonly salaries: SalaryExpensesService) {}

  @Get()
  async list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListExpensesQuery,
  ) {
    return { salaries: await this.salaries.list(principal, query) };
  }

  @Get('staff')
  async staff(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListExpensesQuery,
  ) {
    return { staff: await this.salaries.staff(principal, query) };
  }

  @Post()
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: CreateSalaryDto,
  ) {
    return { salary: await this.salaries.create(principal, dto) };
  }
}
