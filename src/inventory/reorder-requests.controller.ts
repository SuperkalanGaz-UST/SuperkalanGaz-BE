import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { Principal } from '../auth/principal';
import { CurrentPrincipal, Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { CreateReorderRequestDto } from './dto/create-reorder-request.dto';
import { UpdateReorderRequestStatusDto } from './dto/update-reorder-request-status.dto';
import { ReorderRequestsService, ReorderRequestView } from './reorder-requests.service';

@Controller('inventory/reorder-requests')
@UseGuards(AuthGuard, RolesGuard)
@Roles('branch-manager')
export class ReorderRequestsController {
  constructor(private readonly reorderRequests: ReorderRequestsService) {}

  @Get()
  async list(
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ reorderRequests: ReturnType<ReorderRequestsController['toRow']>[] }> {
    const views = await this.reorderRequests.listForBranch(principal);
    return { reorderRequests: views.map((view) => this.toRow(view)) };
  }

  @Post()
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: CreateReorderRequestDto,
  ): Promise<{ reorderRequest: ReturnType<ReorderRequestsController['toRow']> }> {
    const view = await this.reorderRequests.create(principal, dto);
    return { reorderRequest: this.toRow(view) };
  }

  @Patch(':id/status')
  async updateStatus(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateReorderRequestStatusDto,
  ): Promise<{ reorderRequest: ReturnType<ReorderRequestsController['toRow']> }> {
    const view = await this.reorderRequests.updateStatus(principal, id, dto);
    return { reorderRequest: this.toRow(view) };
  }

  private toRow(view: ReorderRequestView) {
    return {
      id: view.id,
      branch_id: view.branchId,
      product_id: view.productId,
      product_name: view.productName,
      cylinder_size: view.cylinderSize,
      requested_qty: view.requestedQty,
      status: view.status,
      requested_by: view.requestedBy,
      requested_by_name: view.requestedByName,
      requested_at: view.requestedAt,
      decided_at: view.decidedAt,
    };
  }
}
