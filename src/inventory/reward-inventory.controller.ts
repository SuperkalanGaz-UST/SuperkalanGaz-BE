import { Body, Controller, Get, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { Principal } from '../auth/principal';
import { CurrentPrincipal, Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { BranchSelectionQuery } from '../common/dto/branch-selection.query';
import { IntakeRewardStockDto } from './dto/intake-reward-stock.dto';
import { RewardInventoryService } from './reward-inventory.service';

/** Additive reward endpoints; LPG endpoints and redemption handlers are unchanged. */
@Controller('inventory/reward-stock-levels')
@UseGuards(AuthGuard, RolesGuard)
@Roles('branch-manager')
export class RewardInventoryController {
  constructor(private readonly rewards: RewardInventoryService) {}

  @Get()
  async list(@CurrentPrincipal() principal: Principal, @Query() query: BranchSelectionQuery) {
    return { rewardStockLevels: await this.rewards.listForManager(principal, query.branchId) };
  }

  @Get('owner')
  @Roles('branch-owner')
  async owner(
    @CurrentPrincipal() principal: Principal,
    @Query('branchId', new ParseUUIDPipe()) branchId: string,
  ) {
    return { rewardStockLevels: await this.rewards.listForOwner(principal, branchId) };
  }

  @Post('intake')
  async intake(@CurrentPrincipal() principal: Principal, @Body() dto: IntakeRewardStockDto) {
    return { rewardStockLevel: await this.rewards.intake(principal, dto) };
  }
}
