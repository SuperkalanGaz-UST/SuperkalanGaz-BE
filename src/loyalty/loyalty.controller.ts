import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { Principal } from '../auth/principal';
import { CurrentPrincipal, Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { CatalogItem } from './catalog-item.entity';
import { CommercialPurchaseRecord } from './commercial-purchase-record.entity';
import { HouseholdPointTransaction } from './household-point-transaction.entity';
import { Redemption } from './redemption.entity';
import { LedgerView, LoyaltyService, RedemptionListItem } from './loyalty.service';
import { CreateRedemptionDto } from './dto/create-redemption.dto';
import { CreateCommercialRedemptionDto } from './dto/create-commercial-redemption.dto';
import { RejectRedemptionDto } from './dto/reject-redemption.dto';
import { UpdateLoyaltySettingsDto } from './dto/update-loyalty-settings.dto';
import { ListRedemptionsQuery } from './dto/list-redemptions.query';
import { UpdateCatalogStockDto } from './dto/update-catalog-stock.dto';
import {
  CreateCustomerCommercialRedemptionDto,
  CreateCustomerRedemptionDto,
} from './dto/create-customer-redemption.dto';
import { BranchSelectionQuery } from './dto/branch-selection.query';

/**
 * Loyalty Program Monitoring HTTP boundary for the separate household-points and
 * commercial-30+1 tracks. Approving loyalty redemptions is Branch Manager day-to-day ops
 * (AGENTS.md §7); FA has no operational writes and the BO configures the catalog
 * but does not approve, so only BM reaches these handlers. Scope comes from the
 * verified Principal, never the client.
 */
@Controller('loyalty')
@UseGuards(AuthGuard, RolesGuard)
export class LoyaltyController {
  constructor(private readonly loyalty: LoyaltyService) {}

  /**
   * Active household reward catalog for the caller's branch(es). Used by the FE
   * to build a redemption request and to render reward names.
   */
  @Get('catalog')
  @Roles('branch-owner', 'branch-manager', 'customer')
  async catalog(
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ catalogItems: ReturnType<LoyaltyController['toCatalogRow']>[] }> {
    // Customers have no branchIds on their principal — use the customer-aware
    // catalog lookup that resolves branches from CIM profiles instead.
    const items =
      principal.role === 'customer'
        ? await this.loyalty.getCustomerCatalog(principal)
        : await this.loyalty.getCatalog(principal);
    return { catalogItems: items.map((i) => this.toCatalogRow(i)) };
  }

  /**
   * Update the stock quantity for a catalog item in the caller's branch.
   * Used by the BM "Manage Reward Items" screen.
   */
  @Patch('catalog/:id/stock')
  @Roles('branch-owner')
  async updateCatalogStock(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCatalogStockDto,
  ): Promise<{ catalogItem: ReturnType<LoyaltyController['toCatalogRow']> }> {
    const item = await this.loyalty.updateCatalogStock(principal, id, dto.stockQty);
    return { catalogItem: this.toCatalogRow(item) };
  }

  /**
   * The approval queue: household redemptions for the caller's branch(es), newest
   * first, filtered by ?status (default 'pending'; 'all' shows every state). Each
   * row is enriched with customer_name, catalog_item_name, and the household's
   * current points_balance for the queue UI.
   */
  @Get('redemptions')
  @Roles('branch-manager')
  async list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListRedemptionsQuery,
  ): Promise<{ redemptions: ReturnType<LoyaltyController['toRedemptionListRow']>[] }> {
    const items = await this.loyalty.listRedemptions(principal, query);
    return { redemptions: items.map((item) => this.toRedemptionListRow(item)) };
  }

  /**
   * Verify a redemption by code: the BM types or pastes the code a customer
   * shows at the counter. Returns the enriched redemption row (same shape as
   * the queue list) or 404 if the code is not found in the caller's branch.
   */
  @Get('redemptions/verify/:code')
  @Roles('branch-manager')
  async verifyByCode(
    @CurrentPrincipal() principal: Principal,
    @Param('code') code: string,
  ): Promise<{ redemption: ReturnType<LoyaltyController['toRedemptionListRow']> }> {
    const item = await this.loyalty.verifyByCode(principal, code);
    return { redemption: this.toRedemptionListRow(item) };
  }

  /**
   * Seed a PENDING household redemption into the queue (BM-US-03). Validates the
   * customer (in-branch, live), the catalog item (in-branch, active, in stock),
   * and that a household account exists — 400/404 otherwise (see the service). No
   * points are debited here. Returns the created row (201).
   */
  @Post('redemptions')
  @Roles('branch-manager')
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
  @Roles('branch-manager')
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
  @Roles('branch-manager')
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
  @Roles('branch-manager')
  async fulfill(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ redemption: ReturnType<LoyaltyController['toRedemptionRow']> }> {
    const row = await this.loyalty.fulfillRedemption(principal, id);
    return { redemption: this.toRedemptionRow(row) };
  }

  /**
   * Seed a PENDING commercial "30+1" free-cylinder redemption (BM-US-03 commercial
   * track). Body is just the customer; there is no reward catalog on this track.
   * Validates the customer (in-branch, live) and that their commercial account has
   * at least one completed cycle — 400 otherwise (see the service). Returns 201.
   */
  @Post('commercial/redemptions')
  @Roles('branch-manager')
  async createCommercial(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: CreateCommercialRedemptionDto,
  ): Promise<{ redemption: ReturnType<LoyaltyController['toRedemptionRow']> }> {
    const row = await this.loyalty.createCommercialRedemption(principal, dto);
    return { redemption: this.toRedemptionRow(row) };
  }

  /**
   * Approve a pending commercial redemption (BM-US-03 commercial track) —
   * transactional: decrements one earned free cylinder (completed_cycles) atomically
   * with the status change. No points, catalog, or ledger on this track. Conflicts
   * (409) if it is not pending or the account has no completed cycle left; 404 if
   * outside the caller's branch. Reject / fulfill are shared with the household
   * track (POST redemptions/:id/reject|fulfill). Returns the approved row.
   */
  @Post('commercial/redemptions/:id/approve')
  @Roles('branch-manager')
  async approveCommercial(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ redemption: ReturnType<LoyaltyController['toRedemptionRow']> }> {
    const row = await this.loyalty.approveCommercialRedemption(principal, id);
    return { redemption: this.toRedemptionRow(row) };
  }

  /**
   * The customer's loyalty ledger for a redemption review (BM-014): current figure
   * + transaction history, so the Branch Manager verifies eligibility before
   * approving. Track-scoped; 404 if the redemption is outside the caller's branch.
   */
  @Get('redemptions/:id/ledger')
  @Roles('branch-manager')
  async ledger(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ ledger: ReturnType<LoyaltyController['toLedgerView']> }> {
    const view = await this.loyalty.getLedger(principal, id);
    return { ledger: this.toLedgerView(view) };
  }

  /**
   * A CIM customer's current loyalty standing, by their CIM profile id — powers
   * the Customer Directory's click-through detail view. Same shape as the
   * redemption ledger, always scoped to that customer's ONE track (household
   * points OR commercial 30+1 cycles — never a blend of both).
   */
  @Get('customers/:customerId')
  @Roles('branch-manager')
  async customerLedger(
    @CurrentPrincipal() principal: Principal,
    @Param('customerId', ParseUUIDPipe) customerId: string,
  ): Promise<{ ledger: ReturnType<LoyaltyController['toLedgerView']> }> {
    const view = await this.loyalty.getCustomerLedgerByCimId(principal, customerId);
    return { ledger: this.toLedgerView(view) };
  }

  /** Branch Owner-managed loyalty configuration for their branch. */
  @Get('settings')
  @Roles('branch-owner')
  async settings(
    @CurrentPrincipal() principal: Principal,
    @Query() query: BranchSelectionQuery,
  ) {
    const s = await this.loyalty.getSettings(principal, query.branchId);
    return {
      settings: {
        branch_id: s.branchId,
        dual_auth: s.dualAuth,
        point_rates: s.pointRates,
      },
    };
  }

  /**
   * Toggle the caller's branch loyalty Dual Authorization (BM-013). When switched
   * OFF, subsequent redemption requests auto-approve + issue a code instead of
   * queuing for manual approval.
   */
  @Patch('settings')
  @Roles('branch-owner')
  async updateSettings(
    @CurrentPrincipal() principal: Principal,
    @Query() query: BranchSelectionQuery,
    @Body() dto: UpdateLoyaltySettingsDto,
  ) {
    const s = await this.loyalty.updateSettings(principal, dto, query.branchId);
    return {
      settings: {
        branch_id: s.branchId,
        dual_auth: s.dualAuth,
        point_rates: s.pointRates,
      },
    };
  }

  // --- Customer / Mobile App Endpoints ---

  @Get('me')
  @Roles('customer')
  async myLedger(@CurrentPrincipal() principal: Principal) {
    const data = await this.loyalty.getCustomerLedger(principal);
    return {
      track: data.track,
      points_balance: data.pointsBalance,
      household_transactions: data.householdTransactions.map((transaction) =>
        this.toHouseholdTxnRow(transaction),
      ),
      household_accounts: data.householdAccounts.map((account) => ({
        branch_id: account.branchId,
        points_balance: account.pointsBalance,
      })),
      commercial_accounts: data.commercialAccounts.map((account) => ({
        branch_id: account.branchId,
        branch_name: account.branchName,
        current_cycle_count: account.currentCycleCount,
        completed_cycles: account.completedCycles,
      })),
      commercial_purchases: data.commercialPurchases.map((purchase) =>
        this.toCommercialPurchaseRow(purchase),
      ),
      active_redemptions: data.activeRedemptions.map((redemption) =>
        this.toRedemptionRow(redemption),
      ),
    };
  }

  @Post('me/redemptions')
  @Roles('customer')
  async createMyRedemption(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: CreateCustomerRedemptionDto,
  ): Promise<{ redemption: ReturnType<LoyaltyController['toRedemptionRow']> }> {
    const row = await this.loyalty.createCustomerRedemption(principal, dto.catalogItemId);
    return { redemption: this.toRedemptionRow(row) };
  }

  @Post('me/commercial-redemptions')
  @Roles('customer')
  async createMyCommercialRedemption(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: CreateCustomerCommercialRedemptionDto,
  ): Promise<{ redemption: ReturnType<LoyaltyController['toRedemptionRow']> }> {
    const row = await this.loyalty.createCustomerCommercialRedemption(
      principal,
      dto.branchId,
    );
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
      catalog_item_name: r.rewardDescription ?? null,
      reward_description: r.rewardDescription,
      points_spent: r.pointsSpent,
      status: r.status,
      requested_at: r.requestedAt,
      approved_by: r.approvedBy,
      approved_at: r.approvedAt,
      rejected_reason: r.rejectedReason,
      fulfilled_at: r.fulfilledAt,
      redemption_code: r.redemptionCode,
      created_at: r.createdAt,
      updated_at: r.updatedAt,
    };
  }

  /**
   * The enriched queue row: the base redemption fields plus per-track figures
   * derived in the service (joins/lookups), not columns on the entity. Household
   * rows populate catalog_item_name + points_balance; commercial rows populate
   * completed_cycles + current_cycle_count. Fields not relevant to the row's track
   * are null.
   */
  private toRedemptionListRow(item: RedemptionListItem) {
    return {
      ...this.toRedemptionRow(item.redemption),
      customer_name: item.customerName,
      catalog_item_name: item.catalogItemName,
      points_balance: item.pointsBalance,
      completed_cycles: item.completedCycles,
      current_cycle_count: item.currentCycleCount,
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

  /**
   * Snake_case ledger view (BM-014): the customer's track, current figure, and the
   * transaction history for that track. Only the array for the row's own track is
   * populated; the other is empty.
   */
  private toLedgerView(v: LedgerView) {
    return {
      track: v.track,
      customer_name: v.customerName,
      points_balance: v.pointsBalance,
      completed_cycles: v.completedCycles,
      current_cycle_count: v.currentCycleCount,
      household_transactions: v.householdTransactions.map((t) =>
        this.toHouseholdTxnRow(t),
      ),
      commercial_purchases: v.commercialPurchases.map((p) =>
        this.toCommercialPurchaseRow(p),
      ),
    };
  }

  /** Snake_case household points-ledger entry. */
  private toHouseholdTxnRow(t: HouseholdPointTransaction) {
    return {
      id: t.id,
      type: t.type,
      points_delta: t.pointsDelta,
      source_service_request_id: t.sourceServiceRequestId,
      redemption_id: t.redemptionId,
      earned_at: t.earnedAt,
      expires_at: t.expiresAt,
      created_at: t.createdAt,
    };
  }

  /** Snake_case commercial purchase record. */
  private toCommercialPurchaseRow(p: CommercialPurchaseRecord) {
    return {
      id: p.id,
      service_request_id: p.serviceRequestId,
      cycle_number: p.cycleNumber,
      counted_at: p.countedAt,
      created_at: p.createdAt,
    };
  }
}
