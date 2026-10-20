import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { CurrentPrincipal, Roles } from '../auth/roles.decorator';
import { Principal } from '../auth/principal';
import { FranchiseReportsQuery } from './franchise-reports.query';
import { FranchiseReportsService } from './franchise-reports.service';

/** Global reads are exclusive to FA; branch operational endpoints retain their scope. */
@Controller('franchise-reports')
@UseGuards(AuthGuard, RolesGuard)
@Roles('franchise-admin')
export class FranchiseReportsController {
  constructor(private readonly reports: FranchiseReportsService) {}

  @Get('orders')
  orders(@CurrentPrincipal() p: Principal, @Query() q: FranchiseReportsQuery) {
    return this.reports.orders(p, q);
  }

  @Get('customers')
  customers(@CurrentPrincipal() p: Principal, @Query() q: FranchiseReportsQuery) {
    return this.reports.customers(p, q);
  }

  @Get('customers/:id')
  customer(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.reports.customer(p, id);
  }

  @Get('csat')
  csat(@CurrentPrincipal() p: Principal, @Query() q: FranchiseReportsQuery) {
    return this.reports.csat(p, q);
  }

  @Get('ratings')
  ratings(@CurrentPrincipal() p: Principal, @Query() q: FranchiseReportsQuery) {
    return this.reports.ratings(p, q);
  }

  @Get('incidents')
  incidents(@CurrentPrincipal() p: Principal, @Query() q: FranchiseReportsQuery) {
    return this.reports.incidents(p, q);
  }
}
