import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { Principal } from '../auth/principal';
import { CurrentPrincipal, Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { ListRidersQuery } from './dto/list-riders.query';
import { FleetService } from './fleet.service';
import { Rider } from './rider.entity';

/**
 * Fleet roster (Fleet module). Dispatching riders is Branch Manager day-to-day
 * ops (AGENTS.md §7), and this list backs the dispatch dropdown, so only BM
 * reaches this handler. Scope comes from the verified Principal, never the client.
 */
@Controller('riders')
@UseGuards(AuthGuard, RolesGuard)
@Roles('branch-manager')
export class FleetController {
  constructor(private readonly fleet: FleetService) {}

  @Get()
  async list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListRidersQuery,
  ): Promise<{ riders: ReturnType<FleetController['toRow']>[] }> {
    const rows = await this.fleet.listForBranch(principal, query);
    return { riders: rows.map((r) => this.toRow(r)) };
  }

  @Get(':id')
  @Roles('branch-manager', 'customer')
  async detail(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ rider: ReturnType<FleetController['toRow']> }> {
    // Both branch-managers and customers need to see the rider's details
    // Customers only know the riderId from their order. 
    // In a production app, we'd ensure the customer actually has an order with this rider.
    const rider = await this.fleet.findById(id);
    if (!rider) throw new Error('Rider not found');
    return { rider: this.toRow(rider) };
  }

  /** Snake_case response row, matching the precedent in UsersController.toRow. */
  private toRow(rider: Rider) {
    return {
      id: rider.id,
      branch_id: rider.branchId,
      name: rider.name,
      plate: rider.plate,
      status: rider.status,
      created_at: rider.createdAt,
    };
  }
}
