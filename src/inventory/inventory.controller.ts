import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { Principal } from '../auth/principal';
import { CurrentPrincipal, Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { IntakeStockDto } from './dto/intake-stock.dto';
import { InventoryService, StockLevelView } from './inventory.service';

@Controller('inventory')
@UseGuards(AuthGuard, RolesGuard)
@Roles('branch-manager')
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get('stock-levels')
  async listStockLevels(
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ stockLevels: ReturnType<InventoryController['toRow']>[] }> {
    const views = await this.inventory.listForBranch(principal);
    return { stockLevels: views.map((view) => this.toRow(view)) };
  }

  @Post('stock-levels/intake')
  async intake(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: IntakeStockDto,
  ): Promise<{ stockLevel: ReturnType<InventoryController['toRow']> }> {
    const view = await this.inventory.intake(principal, dto);
    return { stockLevel: this.toRow(view) };
  }

  private toRow(view: StockLevelView) {
    return {
      stock_level_id: view.stockLevelId,
      branch_id: view.branchId,
      product_id: view.productId,
      product_name: view.productName,
      cylinder_size: view.cylinderSize,
      current_qty: view.currentQty,
      threshold_qty: view.thresholdQty,
      capacity_qty: view.capacityQty,
    };
  }
}
