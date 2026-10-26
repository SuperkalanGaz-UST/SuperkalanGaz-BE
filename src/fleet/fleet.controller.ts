import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { Principal } from '../auth/principal';
import { CurrentPrincipal, Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { ListRidersQuery } from './dto/list-riders.query';
import { FleetService } from './fleet.service';
import { Rider } from './rider.entity';

/**
 * Fleet roster (Fleet module). Dispatching riders is Branch Manager day-to-day
 * ops (AGENTS.md §7). Branch Owners have read-only access to the same
 * branch-scoped roster for their selected branch; operational phone location
 * remains available only to Branch Managers. Scope comes from the verified
 * Principal, never the client.
 */
@Controller('riders')
@UseGuards(AuthGuard, RolesGuard)
@Roles('branch-manager', 'branch-owner')
export class FleetController {
  constructor(private readonly fleet: FleetService) {}

  @Get()
  async list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListRidersQuery,
  ) {
    const rows = await this.fleet.listForBranch(principal, query);
    const [currentOrders, assignedVehicles] = await Promise.all([
      this.fleet.currentOrdersForRiders(rows),
      principal.role === 'branch-manager'
        ? this.fleet.assignedVehiclesForRiders(rows)
        : Promise.resolve(null),
    ]);
    return {
      riders: rows.map((r) => {
        const vehicle = assignedVehicles?.get(r.id);
        return {
          ...this.toRow(r),
          current_order: currentOrders.get(r.id) ?? null,
          ...(principal.role === 'branch-manager'
            ? {
                operational_location: this.fleet.operationalLocationFor(r),
                // Association only: hardware coordinates/IDs stay on the vehicle path.
                assigned_vehicle: vehicle ? {
                  id: vehicle.id,
                  plate_number: vehicle.plateNumber,
                  status: vehicle.status,
                } : null,
              }
            : {}),
        };
      }),
    };
  }

  /**
   * Branch-managers see any rider in their own branch; customers see only a
   * rider they actually have an order with (M4 fix — this had no ownership
   * check at all).
   */
  @Get(':id')
  @Roles('branch-manager', 'customer')
  async detail(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ rider: ReturnType<FleetController['toRow']> }> {
    const rider = await this.fleet.findByIdForCaller(principal, id);
    if (!rider) throw new NotFoundException('Rider not found');
    return { rider: this.toRow(rider) };
  }

  /**
   * Customer-safe row. Operational phone coordinates are added only by the
   * Branch Manager list handler above and never by this shared detail mapper.
   */
  private toRow(rider: Rider) {
    return {
      id: rider.id,
      branch_id: rider.branchId,
      name: rider.name,
      plate: rider.plate,
      status: rider.status,
      created_at: rider.createdAt,
      updated_at: rider.updatedAt,
    };
  }
}
