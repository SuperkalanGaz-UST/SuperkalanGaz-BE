import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { Principal } from '../auth/principal';
import { CurrentPrincipal, Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { CimService } from './cim.service';
import { Customer } from './customer.entity';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { SearchCustomersQuery } from './dto/search-customers.query';

/**
 * Customer Information Management (CIM module). Searching and registering
 * customers happens during order intake, which is Branch Manager day-to-day ops
 * (AGENTS.md §7), so only BM reaches these handlers. Scope comes from the
 * verified Principal, never the client.
 */
@Controller('customers')
@UseGuards(AuthGuard, RolesGuard)
@Roles('branch-manager')
export class CimController {
  constructor(private readonly cim: CimService) {}

  @Get()
  async search(
    @CurrentPrincipal() principal: Principal,
    @Query() query: SearchCustomersQuery,
  ): Promise<{ customers: ReturnType<CimController['toRow']>[] }> {
    const items = await this.cim.search(principal, query);
    return {
      customers: items.map((item) =>
        this.toRow(item.customer, item.lastOrderDate),
      ),
    };
  }

  @Post()
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: CreateCustomerDto,
  ): Promise<{ customer: ReturnType<CimController['toRow']> }> {
    const customer = await this.cim.create(principal, dto);
    // A just-registered customer has no linked orders yet → last_order_date null.
    return { customer: this.toRow(customer, null) };
  }

  /**
   * Snake_case response row, matching the precedent in UsersController.toRow.
   * last_order_date is derived (MAX requested_at across the customer's Service
   * Requests), not a column on the entity, so it is passed in alongside.
   */
  private toRow(customer: Customer, lastOrderDate: Date | null) {
    return {
      id: customer.id,
      branch_id: customer.branchId,
      name: customer.name,
      contact_number: customer.contactNumber,
      delivery_address: customer.deliveryAddress,
      registration_source: customer.registrationSource,
      last_order_date: lastOrderDate,
      created_at: customer.createdAt,
    };
  }
}
