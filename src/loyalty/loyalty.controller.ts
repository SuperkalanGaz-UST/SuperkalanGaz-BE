import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { Principal } from '../auth/principal';
import { CurrentPrincipal, Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { CatalogItem } from './catalog-item.entity';
import { Redemption } from './redemption.entity';
import { LoyaltyService, RedemptionListItem } from './loyalty.service';
import { CreateRedemptionDto } from './dto/create-redemption.dto';
import { RejectRedemptionDto } from './dto/reject-redemption.dto';
import { ListRedemptionsQuery } from './dto/list-redemptions.query';

/**
 * Household loyalty redemption workflow (LPM module, household track only —
 * AGENTS.md §8a). Approving loyalty redemptions is Branch Manager day-to-day ops
 * (AGENTS.md §7); FA has no operational writes and the BO configures the catalog
 * but does not approve, so only BM reaches these handlers. Scope comes from the
 * verified Principal, never the client.
 */
@Controller('loyalty')
@UseGuards(AuthGuard, RolesGuard)
@Roles('branch-manager')
export class LoyaltyController {
  constructor(private readonly loyalty: LoyaltyService) {}

  /**
   * Active household reward catalog for the caller's branch(es). Used by the FE
   * to build a redemption request and to render reward names.
   */
  @Get('catalog')
  async catalog(
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ catalogItems: ReturnType<LoyaltyController['toCatalogRow']>[] }> {
    const items = await this.loyalty.getCatalog(principal);
    return { catalogItems: items.map((i) => this.toCatalogRow(i)) };
  }

  /**
   * The approval queue: household redemptions for the caller's branch(es), newest
   * first, filtered by ?status (default 'pending'; 'all' shows every state). Each
   * row is enriched with customer_name, catalog_item_name, and the household's
   * current points_balance for the queue UI.
   */
  @Get('redemptions')
  async list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListRedemptionsQuery,
  ): Promise<{ redemptions: ReturnType<LoyaltyController['toRedemptionListRow']>[] }> {
    const items = await this.loyalty.listRedemptions(principal, query);
    return { redemptions: items.map((item) => this.toRedemptionListRow(item)) };
  }

  /**
   * Seed a PENDING household redemption into the queue (BM-US-03). Validates the
   * customer (in-branch, live), the catalog item (in-branch, active, in stock),
   * and that a household account exists — 400/404 otherwise (see the service). No
   * points are debited here. Returns the created row (201).
   */
  @Post('redemptions')
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: CreateRedemptionDto,
  ): Promise<{ redemption: ReturnType<LoyaltyController['toRedemptionRow']> }> {
    const row = await this.loyalty.createRedemption(principal, dto);
    return { redemption: this.toRedemptionRow(row) };
  }

  /**
   * Approve a pending redemption (BM-US-03) — transactional: debits the account,
   * decrements catalog stock, and writes the ledger entry atomically. Conflicts
   * (409) if it is not pending, the balance is insufficient, or the item is out
   * of stock; 404 if outside the caller's branch. Returns the approved row.
   */
  @Post('redemptions/:id/approve')
  async approve(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ redemption: ReturnType<LoyaltyController['toRedemptionRow']> }> {
    const row = await this.loyalty.approveRedemption(principal, id);
    return { redemption: this.toRedemptionRow(row) };
  }

  /**
   * Reject a pending redemption (BM-US-03). Requires a non-empty reason (enforced
   * by the DTO → 400 otherwise), recorded on the row. No point/stock changes.
   * Conflicts (409) if it is not pending; 404 if outside the caller's branch.
   * Returns the rejected row.
   */
  @Post('redemptions/:id/reject')
  async reject(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectRedemptionDto,
  ): Promise<{ redemption: ReturnType<LoyaltyController['toRedemptionRow']> }> {
    const row = await this.loyalty.rejectRedemption(principal, id, dto);
    return { redemption: this.toRedemptionRow(row) };
  }

  /**
   * Mark an approved redemption fulfilled (BM-US-03) — the reward was handed over.
   * No request body. Conflicts (409) if it is not approved; 404 if outside the
   * caller's branch. Returns the fulfilled row.
   */
  @Post('redemptions/:id/fulfill')
  async fulfill(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ redemption: ReturnType<LoyaltyController['toRedemptionRow']> }> {
    const row = await this.loyalty.fulfillRedemption(principal, id);
    return { redemption: this.toRedemptionRow(row) };
  }

  /** Snake_case redemption row, matching the precedent in the SRD controller. */
  private toRedemptionRow(r: Redemption) {
    return {
      id: r.id,
      branch_id: r.branchId,
      customer_id: r.customerId,
      track: r.track,
      catalog_item_id: r.catalogItemId,
      reward_description: r.rewardDescription,
      points_spent: r.pointsSpent,
      status: r.status,
      requested_at: r.requestedAt,
      approved_by: r.approvedBy,
      approved_at: r.approvedAt,
      rejected_reason: r.rejectedReason,
      fulfilled_at: r.fulfilledAt,
      created_at: r.createdAt,
      updated_at: r.updatedAt,
    };
  }

  /**
   * The enriched queue row: the base redemption fields plus the resolved
   * customer_name, catalog_item_name, and the household's current points_balance.
   * These three are derived in the service (joins/lookups), not columns on the
   * entity, so they are appended here.
   */
  private toRedemptionListRow(item: RedemptionListItem) {
    return {
      ...this.toRedemptionRow(item.redemption),
      customer_name: item.customerName,
      catalog_item_name: item.catalogItemName,
      points_balance: item.pointsBalance,
    };
  }

  /** Snake_case catalog row. */
  private toCatalogRow(i: CatalogItem) {
    return {
      id: i.id,
      branch_id: i.branchId,
      name: i.name,
      description: i.description,
      points_cost: i.pointsCost,
      stock_qty: i.stockQty,
      is_active: i.isActive,
      created_at: i.createdAt,
      updated_at: i.updatedAt,
    };
  }
}
