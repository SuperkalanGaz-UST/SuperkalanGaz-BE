import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'crypto';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { Principal } from '../auth/principal';
import { CimService } from '../cim/cim.service';
import { Branch, LoyaltyPointRates } from '../branches/branch.entity';
import { CatalogItem } from './catalog-item.entity';
import { CommercialLoyaltyAccount } from './commercial-loyalty-account.entity';
import { CommercialPurchaseRecord } from './commercial-purchase-record.entity';
import { HouseholdLoyaltyAccount } from './household-loyalty-account.entity';
import { HouseholdPointTransaction } from './household-point-transaction.entity';
import { Redemption } from './redemption.entity';
import { CreateRedemptionDto } from './dto/create-redemption.dto';
import { CreateCommercialRedemptionDto } from './dto/create-commercial-redemption.dto';
import { RejectRedemptionDto } from './dto/reject-redemption.dto';
import { ListRedemptionsQuery, RedemptionTrack } from './dto/list-redemptions.query';
import { DEFAULT_CYLINDER_POINTS } from './loyalty.constants';

/** The two loyalty tracks (AGENTS.md §8a) — kept strictly separate, never merged
 * in one query. Values must match the DB CHECK constraint redemptions_track_check.
 * Household earns/spends POINTS against a reward catalog; commercial completes
 * 30-purchase CYCLES that each earn one free cylinder. */
const HOUSEHOLD_TRACK = 'household_points';
const COMMERCIAL_TRACK = 'commercial_30plus1';

/** Reward snapshot for a commercial free-cylinder redemption — the commercial
 * track has no catalog item, so the description is fixed. */
const COMMERCIAL_REWARD = 'Free cylinder (30+1)';

/** A redemption enriched for the approval queue UI: the base row plus the resolved
 * customer name and per-track figures. Household rows carry the catalog reward name
 * + the account's points balance; commercial rows instead carry the account's
 * completed (redeemable) cycles and current cycle progress. Fields not relevant to
 * a row's track are null. The controller flattens this into the snake_case row. */
export interface RedemptionListItem {
  redemption: Redemption;
  customerName: string | null;
  catalogItemName: string | null;
  pointsBalance: number | null;
  completedCycles: number | null;
  currentCycleCount: number | null;
}

/**
 * The customer's loyalty ledger for a redemption review (BM-014): the track, the
 * current figure (household points balance, or commercial completed/current
 * cycles), and the transaction history the Branch Manager verifies eligibility
 * against before approving. Only the arrays for the row's own track are populated.
 */
export interface LedgerView {
  track: RedemptionTrack;
  customerName: string | null;
  pointsBalance: number | null;
  completedCycles: number | null;
  currentCycleCount: number | null;
  householdTransactions: HouseholdPointTransaction[];
  commercialPurchases: CommercialPurchaseRecord[];
}

export interface CustomerCommercialAccountView {
  branchId: string;
  branchName: string | null;
  currentCycleCount: number;
  completedCycles: number;
}

export interface CustomerLedgerView {
  track: RedemptionTrack;
  pointsBalance: number;
  householdTransactions: HouseholdPointTransaction[];
  householdAccounts: Array<{ branchId: string; pointsBalance: number }>;
  commercialAccounts: CustomerCommercialAccountView[];
  commercialPurchases: CommercialPurchaseRecord[];
  activeRedemptions: Redemption[];
}

/**
 * Loyalty Program Monitoring service (AGENTS.md §8a). Household points and
 * commercial 30+1 use separate accounts and immutable ledgers; only the shared
 * redemption lifecycle is represented by the common Redemption entity.
 *
 * All scoping derives from the verified Principal, never from request input
 * (AGENTS.md §5). Isolation is enforced here in the application layer, not by the
 * DB — a missing branch (or track) filter is a cross-tenant / cross-track leak.
 * State transitions use race-safe conditional UPDATEs; approval mutates several
 * tables and therefore runs inside a single transaction.
 */
@Injectable()
export class LoyaltyService {
  constructor(
    @InjectRepository(Redemption)
    private readonly redemptions: Repository<Redemption>,
    @InjectRepository(CatalogItem)
    private readonly catalogItems: Repository<CatalogItem>,
    @InjectRepository(HouseholdLoyaltyAccount)
    private readonly accounts: Repository<HouseholdLoyaltyAccount>,
    @InjectRepository(CommercialLoyaltyAccount)
    private readonly commercialAccounts: Repository<CommercialLoyaltyAccount>,
    @InjectRepository(CommercialPurchaseRecord)
    private readonly commercialPurchases: Repository<CommercialPurchaseRecord>,
    @InjectRepository(HouseholdPointTransaction)
    private readonly ledger: Repository<HouseholdPointTransaction>,
    @InjectRepository(Branch)
    private readonly branches: Repository<Branch>,
    // The approval flow mutates redemption + catalog stock + account balance +
    // ledger atomically, so it needs a transaction that spans all four.
    private readonly dataSource: DataSource,
    // Reused to validate the customer link at request time — the same cross-module
    // reuse the SRD service applies (CimService.findInBranch). LPM → CIM only, so
    // there is no module cycle.
    private readonly cim: CimService,
  ) {}

  /**
   * Look up a single redemption by its redemption code, scoped to the caller's
   * branch. Used by the BM to verify a customer's code at the counter.
   */
  async verifyByCode(
    principal: Principal,
    code: string,
  ): Promise<RedemptionListItem> {
    const branchIds = this.requireBranches(principal);

    const redemption = await this.redemptions.findOne({
      where: { branchId: In(branchIds), redemptionCode: code },
    });
    if (!redemption) {
      throw new NotFoundException('No redemption found with that code.');
    }

    const customerNames = await this.customerNames(branchIds, [redemption.customerId]);

    if (redemption.track === COMMERCIAL_TRACK) {
      const cycles = await this.commercialCycleStats(branchIds, [redemption.customerId]);
      const stat = cycles.get(this.accountKey(redemption.customerId, redemption.branchId));
      return {
        redemption,
        customerName: customerNames.get(redemption.customerId) ?? null,
        catalogItemName: null,
        pointsBalance: null,
        completedCycles: stat?.completedCycles ?? null,
        currentCycleCount: stat?.currentCycleCount ?? null,
      };
    }

    const catalogItemIds = redemption.catalogItemId ? [redemption.catalogItemId] : [];
    const [catalogNames, balances] = await Promise.all([
      this.catalogItemNames(branchIds, catalogItemIds),
      this.accountBalances(branchIds, [redemption.customerId]),
    ]);

    return {
      redemption,
      customerName: customerNames.get(redemption.customerId) ?? null,
      catalogItemName: redemption.catalogItemId
        ? (catalogNames.get(redemption.catalogItemId) ?? null)
        : null,
      pointsBalance:
        balances.get(this.accountKey(redemption.customerId, redemption.branchId)) ?? null,
      completedCycles: null,
      currentCycleCount: null,
    };
  }

  /**
   * The caller's active reward catalog: is_active=true household rewards for their
   * own branch(es), ordered by name. The FE uses this both to build a redemption
   * request and to render reward names. Branch scope comes from the principal;
   * request input can never widen it (AGENTS.md §5).
   */
  async getCatalog(principal: Principal): Promise<CatalogItem[]> {
    const branchIds = this.requireBranches(principal);

    return this.catalogItems.find({
      where: { branchId: In(branchIds), isActive: true },
      order: { pointsCost: 'ASC' },
    });
  }

  /**
   * Update the stock quantity for a catalog item in the caller's branch.
   * Used by the BM "Manage Reward Items" screen.
   */
  async updateCatalogStock(
    principal: Principal,
    itemId: string,
    stockQty: number,
  ): Promise<CatalogItem> {
    const branchIds = this.requireBranches(principal);

    const item = await this.catalogItems.findOne({
      where: { id: itemId, branchId: In(branchIds) },
    });
    if (!item) throw new NotFoundException('Catalog item not found in your branch');

    item.stockQty = stockQty;
    item.updatedAt = new Date();
    return this.catalogItems.save(item);
  }

  /**
   * The active reward catalog for a customer: resolves their branch(es) from CIM
   * profiles and returns all active catalog items across those branches.
   * Used by the mobile customer app where the principal has no branchIds.
   */
  async getCustomerCatalog(principal: Principal): Promise<CatalogItem[]> {
    if (principal.accountType !== 'household') return [];
    const profiles = await this.cim.profilesForAuthUser(principal.userId);
    const branchIds = [...new Set(profiles.map((profile) => profile.branchId))];
    if (branchIds.length === 0) return [];

    return this.catalogItems.find({
      where: { branchId: In(branchIds), isActive: true },
      order: { pointsCost: 'ASC' },
    });
  }

  /**
   * The approval queue for ONE track: redemptions for the caller's branch(es),
   * newest first, optionally narrowed to one lifecycle state (default 'pending';
   * 'all' drops the status filter). ?track selects the track (default household).
   * Rows are enriched per track — household with catalog reward name + points
   * balance, commercial with completed/current cycles — so the queue UI renders
   * without extra round-trips. Branch + track scope come from the principal / the
   * query, never widening beyond the caller's own branch(es) (AGENTS.md §5).
   */
  async listRedemptions(
    principal: Principal,
    query: ListRedemptionsQuery,
  ): Promise<RedemptionListItem[]> {
    const branchIds = this.requireBranches(principal);

    const track: RedemptionTrack = query.track ?? HOUSEHOLD_TRACK;
    // Default to the actionable queue; 'all' means "no status filter".
    const status = query.status ?? 'pending';
    const redemptions = await this.redemptions.find({
      where: {
        branchId: In(branchIds),
        track,
        ...(status === 'all' ? {} : { status }),
      },
      order: { requestedAt: 'DESC' },
    });
    if (redemptions.length === 0) return [];

    const customerIds = [...new Set(redemptions.map((r) => r.customerId))];
    const customerNames = await this.customerNames(branchIds, customerIds);

    // The commercial track has no catalog and no points — it enriches with cycle
    // figures instead. Keep the two tracks' enrichment paths fully separate
    // (AGENTS.md §8a) rather than interleaving their lookups.
    if (track === COMMERCIAL_TRACK) {
      const cycles = await this.commercialCycleStats(branchIds, customerIds);
      return redemptions.map((redemption) => {
        const stat = cycles.get(this.accountKey(redemption.customerId, redemption.branchId));
        return {
          redemption,
          customerName: customerNames.get(redemption.customerId) ?? null,
          catalogItemName: null,
          pointsBalance: null,
          completedCycles: stat?.completedCycles ?? null,
          currentCycleCount: stat?.currentCycleCount ?? null,
        };
      });
    }

    // Household enrichment: catalog reward name + current points balance.
    const catalogItemIds = [
      ...new Set(
        redemptions
          .map((r) => r.catalogItemId)
          .filter((id): id is string => id !== null),
      ),
    ];
    const [catalogNames, balances] = await Promise.all([
      this.catalogItemNames(branchIds, catalogItemIds),
      this.accountBalances(branchIds, customerIds),
    ]);

    return redemptions.map((redemption) => ({
      redemption,
      customerName: customerNames.get(redemption.customerId) ?? null,
      catalogItemName: redemption.catalogItemId
        ? (catalogNames.get(redemption.catalogItemId) ?? null)
        : null,
      // Balance is keyed by (customer, branch) — a household account is per branch.
      pointsBalance:
        balances.get(this.accountKey(redemption.customerId, redemption.branchId)) ??
        null,
      completedCycles: null,
      currentCycleCount: null,
    }));
  }

  /**
   * Seed a PENDING household redemption into the approval queue (BM-US-03). This
   * only files the request; NO points are debited and NO stock is decremented
   * here — those happen on approval. The server owns branch_id, track, status,
   * and the points_spent / reward_description snapshot (AGENTS.md §5).
   *
   * Integrity checks, all in the service layer (no FK constraints, AGENTS.md §6):
   *  1. The customer must be a live cim.customers profile in the caller's branch
   *     (reuses CimService.findInBranch) — else 400.
   *  2. The catalog item must exist in the caller's branch — else 404 (never leak
   *     another branch's item).
   *  3. That item must be active and in stock (stock_qty > 0) — else 400.
   *  4. A household_loyalty_accounts row must exist for (customer, branch) — else
   *     400 (no account = nothing to redeem against).
   */
  async createRedemption(
    principal: Principal,
    dto: CreateRedemptionDto,
  ): Promise<Redemption> {
    const branchId = this.requireBranch(principal);

    // 1. Customer must be live and in the caller's own branch.
    const customer = await this.cim.findInBranch(dto.customerId, branchId);
    if (!customer) {
      throw new BadRequestException('Customer not found in this branch');
    }

    // 2. Catalog item must exist in the caller's branch. Out-of-scope / unknown
    //    ids 404 — never reveal an item from another branch.
    const item = await this.catalogItems.findOne({
      where: { id: dto.catalogItemId, branchId },
    });
    if (!item) throw new NotFoundException('Catalog item not found');

    // 3. It must be currently offered and in stock.
    if (!item.isActive) {
      throw new BadRequestException('Catalog item is not active');
    }
    if (item.stockQty <= 0) {
      throw new BadRequestException('Catalog item is out of stock');
    }

    // 4. The household must have an account in this branch to redeem against.
    const account = await this.accounts.findOne({
      where: { customerId: customer.id, branchId },
    });
    if (!account) {
      throw new BadRequestException('Customer has no loyalty account in this branch');
    }

    // Snapshot the reward name + cost onto the request so the queue is stable even
    // if the catalog item later changes. Points are debited on approval, not now.
    const now = new Date();
    // Dual Authorization gate (BM-013): when ON the request is filed pending for the
    // Branch Manager to approve; when OFF the branch has delegated issuance, so we
    // auto-approve + issue a code immediately in the SAME transaction as the insert.
    const dualAuth = await this.isDualAuth(branchId);

    return this.dataSource.transaction(async (manager) => {
      const redemption = await manager.save(
        Redemption,
        manager.create(Redemption, {
          branchId,
          customerId: customer.id,
          track: HOUSEHOLD_TRACK,
          catalogItemId: item.id,
          rewardDescription: item.name,
          pointsSpent: item.pointsCost,
          status: 'pending',
          requestedAt: now,
          approvedBy: null,
          approvedAt: null,
          rejectedReason: null,
          fulfilledAt: null,
          redemptionCode: null,
          createdAt: now,
          updatedAt: now,
        }),
      );

      if (!dualAuth) {
        const code = await this.settleHouseholdApprovalInTx(
          manager,
          redemption,
          principal.userId,
          now,
        );
        redemption.status = 'approved';
        redemption.approvedBy = principal.userId;
        redemption.approvedAt = now;
        redemption.redemptionCode = code;
        redemption.updatedAt = now;
      }
      return redemption;
    });
  }

  /**
   * Approve a pending household redemption (BM-US-03) — the dual-authorization
   * commit. This mutates FOUR tables and MUST be atomic, so it runs in a single
   * transaction: any failure rolls the whole thing back (no half-applied debit).
   *
   * Steps, all guarded / race-safe (AGENTS.md §8a: re-validate eligibility at
   * approval time, not just at request time):
   *  (a) Conditional-update the redemption pending→approved (stamping approved_by
   *      / approved_at). 0 rows => it is no longer pending (already approved /
   *      rejected, or a concurrent approve won) => 409.
   *  (b) Re-read the account; if balance < points_spent => 409 (rolls back).
   *  (c) Re-check + decrement catalog stock by one via a conditional UPDATE
   *      (WHERE stock_qty > 0). 0 rows => out of stock => 409 (rolls back).
   *  (d) Debit the account by points_spent via a conditional UPDATE
   *      (WHERE points_balance >= spent) — the AUTHORITATIVE insufficient-points
   *      guard, race-safe against a concurrent approval on the same account. 0
   *      rows => 409 (rolls back).
   *  (e) Append the 'redeem' ledger row (negative delta, redemption_id set).
   */
  async approveRedemption(
    principal: Principal,
    id: string,
  ): Promise<Redemption> {
    const branchIds = this.requireBranches(principal);

    return this.dataSource.transaction(async (manager) => {
      // Load scoped to branch + household track. Out-of-scope / unknown / other
      // track all 404 — never leak another branch's or track's row (AGENTS.md §5).
      const redemption = await manager.findOne(Redemption, {
        where: { id, branchId: In(branchIds), track: HOUSEHOLD_TRACK },
      });
      if (!redemption) throw new NotFoundException('Redemption not found');

      const now = new Date();

      // Look up the catalog item's branch so the stock decrement targets the
      // correct branch (customer redemptions can cross branches — the account's
      // branch and the item's branch may differ).
      let catalogItemBranchId: string | undefined;
      if (redemption.catalogItemId) {
        const ci = await manager.findOne(CatalogItem, {
          where: { id: redemption.catalogItemId },
          select: ['branchId'],
        });
        catalogItemBranchId = ci?.branchId;
      }

      const code = await this.settleHouseholdApprovalInTx(
        manager,
        redemption,
        principal.userId,
        now,
        catalogItemBranchId,
      );

      // Reflect the committed state back to the caller without a re-read.
      redemption.status = 'approved';
      redemption.approvedBy = principal.userId;
      redemption.approvedAt = now;
      redemption.redemptionCode = code;
      redemption.updatedAt = now;
      return redemption;
    });
  }

  /**
   * The household approval commit, in an existing transaction. Shared by the manual
   * approve endpoint AND the dual-auth-OFF auto-issue path, so the debit logic lives
   * in exactly one place. Steps, all race-safe (AGENTS.md §8a — re-validate at
   * approval time). Generates + persists the redemption code (BM-016/017). Returns
   * the issued code. Any thrown ConflictException rolls back the caller's transaction.
   *  (a) pending→approved + stamp approver + persist code (0 rows => 409).
   *  (b) re-read account; balance < spent => 409.
   *  (c) decrement catalog stock, race-safe (0 rows => 409 out of stock).
   *  (d) debit balance, race-safe (0 rows => 409 insufficient points).
   *  (e) append the immutable 'redeem' ledger row.
   */
  private async settleHouseholdApprovalInTx(
    manager: EntityManager,
    redemption: Redemption,
    userId: string,
    now: Date,
    catalogItemBranchId?: string,
  ): Promise<string> {
    const pointsSpent = redemption.pointsSpent ?? 0;
    // Reuse the pre-generated code if present; only generate a new one for
    // BM-initiated redemptions that don't have one yet.
    const code = redemption.redemptionCode ?? await this.issueCode(manager);

    // (a) Commit the transition + code atomically. Only a still-pending row in scope
    //     is updated; 0 rows => a concurrent approve/reject already won.
    const approved = await manager
      .createQueryBuilder()
      .update(Redemption)
      .set({
        status: 'approved',
        approvedBy: userId,
        approvedAt: now,
        redemptionCode: code,
        updatedAt: now,
      })
      .where(
        'id = :id AND branch_id = :branchId AND track = :track AND status = :status',
        { id: redemption.id, branchId: redemption.branchId, track: HOUSEHOLD_TRACK, status: 'pending' },
      )
      .execute();
    if (!approved.affected) {
      throw new ConflictException('Redemption is not pending');
    }

    // (b) Re-read the account (fast, clear error). The authoritative debit guard is
    //     the conditional UPDATE in (d).
    const account = await manager.findOne(HouseholdLoyaltyAccount, {
      where: { customerId: redemption.customerId, branchId: redemption.branchId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!account) {
      throw new ConflictException('Loyalty account not found');
    }
    await this.expireHouseholdPointsInTx(manager, account, now);
    if (account.pointsBalance < pointsSpent) {
      throw new ConflictException('insufficient points');
    }

    // (c) Decrement stock, race-safe, only when a catalog item is linked. 0 rows =>
    //     the last unit was taken concurrently.
    if (redemption.catalogItemId) {
      const stock = await manager
        .createQueryBuilder()
        .update(CatalogItem)
        .set({ stockQty: () => 'stock_qty - 1', updatedAt: now })
        .where('id = :id AND branch_id = :branchId AND stock_qty > 0', {
          id: redemption.catalogItemId,
          branchId: catalogItemBranchId ?? redemption.branchId,
        })
        .execute();
      if (!stock.affected) {
        throw new ConflictException('out of stock');
      }
    }

    // (d) Debit the balance, race-safe against a concurrent approval on the same
    //     account. pointsSpent is a trusted integer (our own snapshot), so inlining
    //     it in the SET expression carries no injection risk. 0 rows => the balance
    //     dropped below the cost => 409.
    const debited = await manager
      .createQueryBuilder()
      .update(HouseholdLoyaltyAccount)
      .set({
        pointsBalance: () => `points_balance - ${pointsSpent}`,
        updatedAt: now,
      })
      .where('id = :id AND points_balance >= :spent', {
        id: account.id,
        spent: pointsSpent,
      })
      .execute();
    if (!debited.affected) {
      throw new ConflictException('insufficient points');
    }

    // (e) Append the immutable ledger entry recording the spend.
    await manager.save(
      HouseholdPointTransaction,
      manager.create(HouseholdPointTransaction, {
        accountId: account.id,
        customerId: redemption.customerId,
        branchId: redemption.branchId,
        type: 'redeem',
        pointsDelta: -pointsSpent,
        sourceServiceRequestId: null,
        redemptionId: redemption.id,
        sourcePointTransactionId: null,
        earnedAt: null,
        expiresAt: null,
        createdAt: now,
      }),
    );

    return code;
  }

  /**
   * Reject a pending redemption (BM-US-03) — track-agnostic. Rejecting is a pure
   * status transition with no earn/spend side effects (no points, stock, or cycles
   * change), so it is shared by BOTH tracks; the row's own `track` is left as-is.
   * Records who actioned it (approved_by / approved_at) and the reason. The
   * pending→rejected transition is race-safe: 0 rows affected (already approved /
   * rejected, or a concurrent action won) => 409. Branch scope still isolates the
   * caller (AGENTS.md §5).
   */
  async rejectRedemption(
    principal: Principal,
    id: string,
    dto: RejectRedemptionDto,
  ): Promise<Redemption> {
    const branchIds = this.requireBranches(principal);

    // Load scoped to branch — 404 if missing / out of scope. A redemption id is
    // globally unique, so branch scope alone is sufficient isolation for a status
    // transition; no track filter (this handler serves both tracks).
    const redemption = await this.redemptions.findOne({
      where: { id, branchId: In(branchIds) },
    });
    if (!redemption) throw new NotFoundException('Redemption not found');

    const now = new Date();
    const result = await this.redemptions
      .createQueryBuilder()
      .update(Redemption)
      .set({
        status: 'rejected',
        rejectedReason: dto.reason,
        approvedBy: principal.userId,
        approvedAt: now,
        updatedAt: now,
      })
      .where(
        'id = :id AND branch_id IN (:...branchIds) AND status = :status',
        { id, branchIds, status: 'pending' },
      )
      .execute();
    if (!result.affected) {
      throw new ConflictException('Redemption is not pending');
    }

    // Reflect the committed state back to the caller without a re-read.
    redemption.status = 'rejected';
    redemption.rejectedReason = dto.reason;
    redemption.approvedBy = principal.userId;
    redemption.approvedAt = now;
    redemption.updatedAt = now;
    return redemption;
  }

  /**
   * Mark an approved redemption fulfilled (BM-US-03) — track-agnostic. The reward
   * (a catalog item or a free cylinder) has been physically handed over. Fulfilling
   * is a pure status transition with no side effects, so it is shared by BOTH
   * tracks. Stamps fulfilled_at. The approved→fulfilled transition is race-safe: 0
   * rows affected (still pending, already fulfilled, or rejected) => 409.
   */
  async fulfillRedemption(
    principal: Principal,
    id: string,
  ): Promise<Redemption> {
    const branchIds = this.requireBranches(principal);

    // Load scoped to branch — 404 if missing / out of scope. No track filter: this
    // handler serves both tracks and a status transition needs only branch scope.
    const redemption = await this.redemptions.findOne({
      where: { id, branchId: In(branchIds) },
    });
    if (!redemption) throw new NotFoundException('Redemption not found');

    const now = new Date();
    const result = await this.redemptions
      .createQueryBuilder()
      .update(Redemption)
      .set({ status: 'fulfilled', fulfilledAt: now, updatedAt: now })
      .where(
        'id = :id AND branch_id IN (:...branchIds) AND status = :status',
        { id, branchIds, status: 'approved' },
      )
      .execute();
    if (!result.affected) {
      throw new ConflictException('Redemption is not approved');
    }

    // Reflect the committed state back to the caller without a re-read.
    redemption.status = 'fulfilled';
    redemption.fulfilledAt = now;
    redemption.updatedAt = now;
    return redemption;
  }

  /**
   * File a PENDING commercial "30+1" free-cylinder redemption (BM-US-03 commercial
   * track). Only files the request; the free cylinder is deducted on approval, not
   * here. The server owns branch_id, track, status, and the reward snapshot; there
   * is no catalog item and no points on this track (AGENTS.md §5, §8a).
   *
   * Integrity checks in the service layer (no FK constraints, AGENTS.md §6):
   *  1. The customer must be a live cim.customers profile in the caller's branch.
   *  2. A commercial_loyalty_accounts row must exist for (customer, branch).
   *  3. That account must have at least one completed (earned) cycle to redeem —
   *     else 400 (nothing to redeem yet).
   */
  async createCommercialRedemption(
    principal: Principal,
    dto: CreateCommercialRedemptionDto,
  ): Promise<Redemption> {
    const branchId = this.requireBranch(principal);

    const customer = await this.cim.findInBranch(dto.customerId, branchId);
    if (!customer) {
      throw new BadRequestException('Customer not found in this branch');
    }

    const account = await this.commercialAccounts.findOne({
      where: { customerId: customer.id, branchId },
    });
    if (!account) {
      throw new BadRequestException('Customer has no commercial loyalty account in this branch');
    }
    if (account.completedCycles < 1) {
      throw new BadRequestException('No completed cycle available to redeem yet');
    }

    const now = new Date();
    // Dual Authorization gate (BM-013), same as household: ON => pending queue;
    // OFF => auto-approve + issue a code in the same transaction as the insert.
    const dualAuth = await this.isDualAuth(branchId);

    return this.dataSource.transaction(async (manager) => {
      const redemption = await manager.save(
        Redemption,
        manager.create(Redemption, {
          branchId,
          customerId: customer.id,
          track: COMMERCIAL_TRACK,
          catalogItemId: null,
          rewardDescription: COMMERCIAL_REWARD,
          pointsSpent: null,
          status: 'pending',
          requestedAt: now,
          approvedBy: null,
          approvedAt: null,
          rejectedReason: null,
          fulfilledAt: null,
          redemptionCode: null,
          createdAt: now,
          updatedAt: now,
        }),
      );

      if (!dualAuth) {
        const code = await this.settleCommercialApprovalInTx(
          manager,
          redemption,
          principal.userId,
          now,
        );
        redemption.status = 'approved';
        redemption.approvedBy = principal.userId;
        redemption.approvedAt = now;
        redemption.redemptionCode = code;
        redemption.updatedAt = now;
      }
      return redemption;
    });
  }

  /**
   * Approve a pending commercial free-cylinder redemption (BM-US-03 commercial
   * track) — the dual-authorization commit. Mutates the redemption AND the
   * account's completed_cycles, so it runs in a single transaction. Unlike the
   * household track there are no points, no catalog stock, and no ledger: the
   * only debit is one earned free cylinder.
   *
   * Steps, race-safe (AGENTS.md §8a: re-validate eligibility at approval time):
   *  (a) Conditional-update the redemption pending→approved. 0 rows => it is no
   *      longer pending (already actioned, or a concurrent approve won) => 409.
   *  (b) Decrement completed_cycles by one via a conditional UPDATE
   *      (WHERE completed_cycles >= 1) — the AUTHORITATIVE eligibility guard,
   *      race-safe against a concurrent approval on the same account. 0 rows =>
   *      no cycle left to redeem => 409 (rolls back the whole transaction).
   */
  async approveCommercialRedemption(
    principal: Principal,
    id: string,
  ): Promise<Redemption> {
    const branchIds = this.requireBranches(principal);

    return this.dataSource.transaction(async (manager) => {
      // Load scoped to branch + commercial track — 404 otherwise (never leak
      // another branch's or the household track's row).
      const redemption = await manager.findOne(Redemption, {
        where: { id, branchId: In(branchIds), track: COMMERCIAL_TRACK },
      });
      if (!redemption) throw new NotFoundException('Redemption not found');

      const now = new Date();
      const code = await this.settleCommercialApprovalInTx(
        manager,
        redemption,
        principal.userId,
        now,
      );

      // Reflect the committed state back to the caller without a re-read.
      redemption.status = 'approved';
      redemption.approvedBy = principal.userId;
      redemption.approvedAt = now;
      redemption.redemptionCode = code;
      redemption.updatedAt = now;
      return redemption;
    });
  }

  /**
   * The commercial approval commit, in an existing transaction. Shared by the manual
   * approve endpoint AND the dual-auth-OFF auto-issue path. Generates + persists the
   * redemption code (BM-016/017) and redeems one earned free cylinder. Returns the
   * code. Any ConflictException rolls back the caller's transaction. There are no
   * points, catalog stock, or ledger on this track — the only debit is a cycle.
   *  (a) pending→approved + stamp approver + persist code (0 rows => 409).
   *  (b) decrement completed_cycles, race-safe (0 rows => 409 no cycle to redeem).
   */
  private async settleCommercialApprovalInTx(
    manager: EntityManager,
    redemption: Redemption,
    userId: string,
    now: Date,
  ): Promise<string> {
    const code = await this.issueCode(manager);

    // (a) Commit the transition + code atomically, race-safe.
    const approved = await manager
      .createQueryBuilder()
      .update(Redemption)
      .set({
        status: 'approved',
        approvedBy: userId,
        approvedAt: now,
        redemptionCode: code,
        updatedAt: now,
      })
      .where(
        'id = :id AND branch_id = :branchId AND track = :track AND status = :status',
        { id: redemption.id, branchId: redemption.branchId, track: COMMERCIAL_TRACK, status: 'pending' },
      )
      .execute();
    if (!approved.affected) {
      throw new ConflictException('Redemption is not pending');
    }

    // (b) Redeem one earned free cylinder, race-safe. 0 rows => the account has no
    //     completed cycle left (or none exists) => 409 + rollback.
    const debited = await manager
      .createQueryBuilder()
      .update(CommercialLoyaltyAccount)
      .set({ completedCycles: () => 'completed_cycles - 1', updatedAt: now })
      .where(
        'customer_id = :customerId AND branch_id = :branchId AND completed_cycles >= 1',
        { customerId: redemption.customerId, branchId: redemption.branchId },
      )
      .execute();
    if (!debited.affected) {
      throw new ConflictException('No completed cycle available to redeem');
    }

    return code;
  }

  /**
   * Generate a unique redemption code (BM-017) inside the given transaction. Format
   * RDM-XXXXXXXX in Crockford base32 (no I/L/O/U — unambiguous when read aloud or
   * hand-written at the counter). Collisions are astronomically unlikely but the
   * partial unique index is the real guarantee; we probe-and-retry a few times so a
   * clash surfaces here rather than as an INSERT failure.
   */
  private async issueCode(manager: EntityManager): Promise<string> {
    const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    for (let attempt = 0; attempt < 6; attempt++) {
      const bytes = randomBytes(8);
      let body = '';
      for (let i = 0; i < 8; i++) body += ALPHABET[bytes[i] % ALPHABET.length];
      const code = `RDM-${body}`;
      const clash = await manager.findOne(Redemption, {
        where: { redemptionCode: code },
        select: { id: true },
      });
      if (!clash) return code;
    }
    throw new ConflictException('Could not generate a unique redemption code');
  }

  /**
   * The customer's loyalty ledger for a redemption review (BM-014): current figure
   * + transaction history, so the Branch Manager can verify eligibility independently
   * before approving. Scoped to the caller's branch(es); a redemption outside scope
   * 404s. Only the arrays for the row's own track are populated (the two tracks are
   * kept separate, AGENTS.md §8a).
   */
  async getLedger(principal: Principal, redemptionId: string): Promise<LedgerView> {
    const branchIds = this.requireBranches(principal);

    const redemption = await this.redemptions.findOne({
      where: { id: redemptionId, branchId: In(branchIds) },
    });
    if (!redemption) throw new NotFoundException('Redemption not found');

    const customerName =
      (await this.customerNames(branchIds, [redemption.customerId])).get(
        redemption.customerId,
      ) ?? null;

    return this.buildLedgerView(
      redemption.customerId,
      redemption.branchId,
      redemption.track as RedemptionTrack,
      customerName,
    );
  }

  /**
   * A CIM customer's current loyalty standing for the Branch Manager's Customer
   * Directory (click-through detail view) — resolved by their CIM profile id
   * rather than a redemption id. The track is never ambiguous: a customer
   * profile carries exactly one accountType (household or commercial), so this
   * always returns that ONE track's figures, never a blend of both — the same
   * separation the loyalty redemption queue already enforces via its track tabs.
   * 404s when the id is unknown or outside the caller's branch scope.
   */
  async getCustomerLedgerByCimId(
    principal: Principal,
    customerId: string,
  ): Promise<LedgerView> {
    const branchIds = this.requireBranches(principal);
    const customer = await this.cim.findInBranches(customerId, branchIds);
    if (!customer) throw new NotFoundException('Customer not found');

    const track: RedemptionTrack =
      customer.accountType === 'commercial' ? COMMERCIAL_TRACK : HOUSEHOLD_TRACK;
    return this.buildLedgerView(customer.id, customer.branchId, track, customer.name);
  }

  /** Shared by getLedger and getCustomerLedgerByCimId: the household-or-commercial
   * figures for one (customerId, branchId), scoped to exactly the requested track
   * so the two mechanics (points vs 30+1 cycles) never mix in one response. */
  private async buildLedgerView(
    customerId: string,
    branchId: string,
    track: RedemptionTrack,
    customerName: string | null,
  ): Promise<LedgerView> {
    if (track === COMMERCIAL_TRACK) {
      const account = await this.commercialAccounts.findOne({
        where: { customerId, branchId },
      });
      const commercialPurchases = await this.commercialPurchases.find({
        where: { customerId, branchId },
        order: { countedAt: 'DESC' },
        take: 100,
      });
      return {
        track: COMMERCIAL_TRACK,
        customerName,
        pointsBalance: null,
        completedCycles: account?.completedCycles ?? null,
        currentCycleCount: account?.currentCycleCount ?? null,
        householdTransactions: [],
        commercialPurchases,
      };
    }

    const account = await this.accounts.findOne({ where: { customerId, branchId } });
    if (account) await this.expireHouseholdAccount(account.id);
    const currentAccount = account
      ? await this.accounts.findOne({ where: { id: account.id } })
      : null;
    const householdTransactions = await this.ledger.find({
      where: { customerId, branchId },
      order: { createdAt: 'DESC' },
      take: 100,
    });
    return {
      track: HOUSEHOLD_TRACK,
      customerName,
      pointsBalance: currentAccount?.pointsBalance ?? null,
      completedCycles: null,
      currentCycleCount: null,
      householdTransactions,
      commercialPurchases: [],
    };
  }

  /** The caller's branch loyalty Dual Authorization setting (BM-013). */
  async getSettings(principal: Principal, selectedBranchId?: string): Promise<{
    branchId: string;
    dualAuth: boolean;
    pointRates: LoyaltyPointRates;
  }> {
    const branchId = this.requireSelectedBranch(principal, selectedBranchId);
    const branch = await this.branches.findOne({ where: { id: branchId } });
    if (!branch) throw new NotFoundException('Branch not found');
    return {
      branchId,
      dualAuth: branch.loyaltyDualAuth,
      pointRates: branch.loyaltyPointRates ?? { ...DEFAULT_CYLINDER_POINTS },
    };
  }

  /** Toggle the caller's branch loyalty Dual Authorization setting (BM-013). */
  async updateSettings(
    principal: Principal,
    input: { dualAuth?: boolean; pointRates?: LoyaltyPointRates },
    selectedBranchId?: string,
  ): Promise<{ branchId: string; dualAuth: boolean; pointRates: LoyaltyPointRates }> {
    const branchId = this.requireSelectedBranch(principal, selectedBranchId);
    const branch = await this.branches.findOne({ where: { id: branchId } });
    if (!branch) throw new NotFoundException('Branch not found');
    if (input.dualAuth !== undefined) branch.loyaltyDualAuth = input.dualAuth;
    if (input.pointRates !== undefined) branch.loyaltyPointRates = input.pointRates;
    branch.updatedAt = new Date();
    const saved = await this.branches.save(branch);
    return {
      branchId,
      dualAuth: saved.loyaltyDualAuth,
      pointRates: saved.loyaltyPointRates,
    };
  }

  /** Whether the branch requires Branch Manager dual authorization for redemptions.
   * Fails SAFE — a missing branch defaults to requiring approval (never auto-issue). */
  private async isDualAuth(branchId: string): Promise<boolean> {
    const branch = await this.branches.findOne({
      where: { id: branchId },
      select: { id: true, loyaltyDualAuth: true },
    });
    return branch?.loyaltyDualAuth ?? true;
  }

  /**
   * Resolve customer names by id, scoped to the caller's branch(es) and excluding
   * soft-deleted rows. Read from cim.customers by table name (NOT the Customer
   * entity) on purpose — mirrors CimService.lastOrderDates: LPM reuses CimService
   * for the write-path validation but reads the customers table directly for this
   * bulk display lookup, keeping the dependency one-way (LPM → CIM).
   */
  private async customerNames(
    branchIds: string[],
    customerIds: string[],
  ): Promise<Map<string, string>> {
    if (customerIds.length === 0) return new Map();

    const rows = await this.redemptions.manager
      .createQueryBuilder()
      .select('c.id', 'id')
      .addSelect('c.name', 'name')
      .from('cim.customers', 'c')
      .where('c.id IN (:...customerIds)', { customerIds })
      .andWhere('c.branch_id IN (:...branchIds)', { branchIds })
      .andWhere('c.deleted_at IS NULL')
      .getRawMany<{ id: string; name: string }>();

    return new Map(rows.map((r) => [r.id, r.name]));
  }

  /** Resolve catalog reward names by id, scoped to the caller's branch(es). */
  private async catalogItemNames(
    branchIds: string[],
    catalogItemIds: string[],
  ): Promise<Map<string, string>> {
    if (catalogItemIds.length === 0) return new Map();

    const items = await this.catalogItems.find({
      where: { id: In(catalogItemIds), branchId: In(branchIds) },
    });
    return new Map(items.map((i) => [i.id, i.name]));
  }

  /**
   * Current balance per household account, keyed by (customer, branch). Scoped to
   * the caller's branch(es); a customer without an account is simply absent (→
   * null in the list row).
   */
  private async accountBalances(
    branchIds: string[],
    customerIds: string[],
  ): Promise<Map<string, number>> {
    if (customerIds.length === 0) return new Map();

    const accounts = await this.accounts.find({
      where: { customerId: In(customerIds), branchId: In(branchIds) },
    });
    for (const account of accounts) await this.expireHouseholdAccount(account.id);
    const currentAccounts = await this.accounts.find({
      where: { customerId: In(customerIds), branchId: In(branchIds) },
    });
    return new Map(
      currentAccounts.map((a) => [this.accountKey(a.customerId, a.branchId), a.pointsBalance]),
    );
  }

  /**
   * Cycle figures per commercial account, keyed by (customer, branch): the number
   * of completed (redeemable) cycles and progress toward the next. Scoped to the
   * caller's branch(es); a customer without a commercial account is simply absent
   * (→ null cycle figures in the list row). The commercial analogue of
   * accountBalances.
   */
  private async commercialCycleStats(
    branchIds: string[],
    customerIds: string[],
  ): Promise<Map<string, { completedCycles: number; currentCycleCount: number }>> {
    if (customerIds.length === 0) return new Map();

    const accounts = await this.commercialAccounts.find({
      where: { customerId: In(customerIds), branchId: In(branchIds) },
    });
    return new Map(
      accounts.map((a) => [
        this.accountKey(a.customerId, a.branchId),
        { completedCycles: a.completedCycles, currentCycleCount: a.currentCycleCount },
      ]),
    );
  }

  /** Composite key for the per-(customer, branch) balance map. */
  private accountKey(customerId: string, branchId: string): string {
    return `${customerId}:${branchId}`;
  }

  /** The caller's active branch UUIDs; fails closed if they have none. */
  private requireBranches(principal: Principal): string[] {
    if (principal.branchIds.length === 0) {
      throw new ForbiddenException('Caller has no active branch');
    }
    return principal.branchIds;
  }

  /** The single branch a new redemption is filed under — the caller's own branch. */
  private requireBranch(principal: Principal): string {
    return this.requireBranches(principal)[0];
  }

  /**
   * Resolve a Branch Owner's explicit UI context. Single-branch owners may omit
   * it for backward compatibility; multi-branch owners must choose one UUID.
   */
  private requireSelectedBranch(
    principal: Principal,
    selectedBranchId?: string,
  ): string {
    const authorized = this.requireBranches(principal);
    if (selectedBranchId) {
      if (!authorized.includes(selectedBranchId)) {
        throw new ForbiddenException('Requested branch is outside your authorized scope');
      }
      return selectedBranchId;
    }
    if (authorized.length !== 1) {
      throw new BadRequestException('Select a branch before managing its settings');
    }
    return authorized[0];
  }

  // --- Delivery earning + Customer / Mobile App Endpoints ---

  /** Credit exactly one loyalty track from the server-owned CIM classification. */
  async recordDeliveredPurchase(
    customerId: string,
    branchId: string,
    serviceRequestId: string,
    cylinderSize: string,
    quantity = 1,
  ): Promise<void> {
    const customer = await this.cim.findInBranch(customerId, branchId);
    if (!customer) throw new BadRequestException('Customer not found in this branch');

    if (customer.accountType === 'commercial') {
      await this.recordCommercialPurchase(customerId, branchId, serviceRequestId);
      return;
    }
    await this.recordHouseholdEarn(
      customerId,
      branchId,
      serviceRequestId,
      cylinderSize,
      quantity,
    );
  }

  /** Idempotently earn household points for one delivered Service Request. */
  async recordHouseholdEarn(
    customerId: string,
    branchId: string,
    serviceRequestId: string,
    cylinderSize: string,
    quantity = 1,
  ): Promise<void> {
    const now = new Date();
    const expiresAt = new Date(now);
    expiresAt.setUTCFullYear(expiresAt.getUTCFullYear() + 1);

    await this.dataSource.transaction(async (manager) => {
      const branch = await manager.findOne(Branch, { where: { id: branchId } });
      if (!branch) throw new BadRequestException('Branch not found');
      const rates = branch.loyaltyPointRates ?? DEFAULT_CYLINDER_POINTS;
      const pointsPerUnit = rates[cylinderSize as keyof LoyaltyPointRates];
      if (!Number.isInteger(pointsPerUnit) || pointsPerUnit <= 0) return;
      const points = pointsPerUnit * quantity;

      await manager
        .createQueryBuilder()
        .insert()
        .into(HouseholdLoyaltyAccount)
        .values({ customerId, branchId, pointsBalance: 0, createdAt: now, updatedAt: now })
        .orIgnore()
        .execute();
      const account = await manager.findOneOrFail(HouseholdLoyaltyAccount, {
        where: { customerId, branchId },
        lock: { mode: 'pessimistic_write' },
      });

      await this.expireHouseholdPointsInTx(manager, account, now);
      const existing = await manager.findOne(HouseholdPointTransaction, {
        where: { sourceServiceRequestId: serviceRequestId, type: 'earn' },
        select: { id: true },
      });
      if (existing) return;

      await manager.save(
        HouseholdPointTransaction,
        manager.create(HouseholdPointTransaction, {
          accountId: account.id,
          customerId,
          branchId,
          type: 'earn',
          pointsDelta: points,
          sourceServiceRequestId: serviceRequestId,
          redemptionId: null,
          sourcePointTransactionId: null,
          earnedAt: now,
          expiresAt,
          createdAt: now,
        }),
      );
      await manager
        .createQueryBuilder()
        .update(HouseholdLoyaltyAccount)
        .set({ pointsBalance: () => `points_balance + ${points}`, updatedAt: now })
        .where('id = :id', { id: account.id })
        .execute();
    });
  }

  /** Idempotently count one delivered commercial order toward the 30+1 cycle. */
  async recordCommercialPurchase(
    customerId: string,
    branchId: string,
    serviceRequestId: string,
  ): Promise<void> {
    const now = new Date();
    await this.dataSource.transaction(async (manager) => {
      await manager
        .createQueryBuilder()
        .insert()
        .into(CommercialLoyaltyAccount)
        .values({
          customerId,
          branchId,
          currentCycleCount: 0,
          completedCycles: 0,
          createdAt: now,
          updatedAt: now,
        })
        .orIgnore()
        .execute();
      const account = await manager.findOneOrFail(CommercialLoyaltyAccount, {
        where: { customerId, branchId },
        lock: { mode: 'pessimistic_write' },
      });
      const existing = await manager.findOne(CommercialPurchaseRecord, {
        where: { serviceRequestId },
        select: { id: true },
      });
      if (existing) return;

      const latest = await manager.findOne(CommercialPurchaseRecord, {
        where: { accountId: account.id },
        order: { countedAt: 'DESC' },
      });
      const completesCycle = account.currentCycleCount + 1 >= 30;
      const cycleNumber = latest
        ? account.currentCycleCount === 0
          ? latest.cycleNumber + 1
          : latest.cycleNumber
        : 1;
      await manager.save(
        CommercialPurchaseRecord,
        manager.create(CommercialPurchaseRecord, {
          accountId: account.id,
          customerId,
          branchId,
          serviceRequestId,
          cycleNumber,
          countedAt: now,
          createdAt: now,
        }),
      );
      await manager.update(
        CommercialLoyaltyAccount,
        { id: account.id },
        {
          currentCycleCount: completesCycle ? 0 : account.currentCycleCount + 1,
          completedCycles: account.completedCycles + (completesCycle ? 1 : 0),
          updatedAt: now,
        },
      );
    });
  }

  /** Customer-owned view. Only the authenticated customer's selected track is populated. */
  async getCustomerLedger(principal: Principal): Promise<CustomerLedgerView> {
    if (!principal.accountType) {
      throw new ForbiddenException('Customer account type is missing');
    }
    const profiles = await this.cim.profilesForAuthUser(principal.userId);
    const matchingProfiles = profiles.filter(
      (profile) => profile.accountType === principal.accountType,
    );
    const ownedCustomerIds = [...new Set(matchingProfiles.map((profile) => profile.id))];
    const track: RedemptionTrack =
      principal.accountType === 'commercial' ? COMMERCIAL_TRACK : HOUSEHOLD_TRACK;
    if (ownedCustomerIds.length === 0) {
      return {
        track,
        pointsBalance: 0,
        householdTransactions: [],
        householdAccounts: [],
        commercialAccounts: [],
        commercialPurchases: [],
        activeRedemptions: [],
      };
    }

    const activeRedemptions = await this.redemptions.find({
      where: {
        customerId: In(ownedCustomerIds),
        track,
        status: In(['pending', 'approved']),
      },
      order: { requestedAt: 'DESC' },
    });

    if (track === COMMERCIAL_TRACK) {
      const [commercialAccounts, commercialPurchases] = await Promise.all([
        this.commercialAccounts.find({ where: { customerId: In(ownedCustomerIds) } }),
        this.commercialPurchases.find({
          where: { customerId: In(ownedCustomerIds) },
          order: { countedAt: 'DESC' },
          take: 100,
        }),
      ]);
      const branchIds = [...new Set(commercialAccounts.map((account) => account.branchId))];
      const branches = branchIds.length
        ? await this.branches.find({ where: { id: In(branchIds), status: 'active' } })
        : [];
      const branchNames = new Map(branches.map((branch) => [branch.id, branch.name]));
      return {
        track,
        pointsBalance: 0,
        householdTransactions: [],
        householdAccounts: [],
        commercialAccounts: commercialAccounts.map((account) => ({
          branchId: account.branchId,
          branchName: branchNames.get(account.branchId) ?? null,
          currentCycleCount: account.currentCycleCount,
          completedCycles: account.completedCycles,
        })),
        commercialPurchases,
        activeRedemptions,
      };
    }

    const accounts = await this.accounts.find({ where: { customerId: In(ownedCustomerIds) } });
    for (const account of accounts) await this.expireHouseholdAccount(account.id);
    const currentAccounts = await this.accounts.find({
      where: { customerId: In(ownedCustomerIds) },
    });
    const householdTransactions = await this.ledger.find({
      where: { customerId: In(ownedCustomerIds) },
      order: { createdAt: 'DESC' },
      take: 100,
    });
    return {
      track,
      pointsBalance: currentAccounts.reduce((sum, account) => sum + account.pointsBalance, 0),
      householdTransactions,
      householdAccounts: currentAccounts.map((account) => ({
        branchId: account.branchId,
        pointsBalance: account.pointsBalance,
      })),
      commercialAccounts: [],
      commercialPurchases: [],
      activeRedemptions,
    };
  }

  /** Customer household redemption, constrained to the catalog item's own branch. */
  async createCustomerRedemption(
    principal: Principal,
    catalogItemId: string,
  ): Promise<Redemption> {
    if (principal.accountType !== 'household') {
      throw new ForbiddenException('This account does not use household points');
    }
    const item = await this.catalogItems.findOne({ where: { id: catalogItemId } });
    if (!item) throw new NotFoundException('Catalog item not found');
    if (!item.isActive) throw new BadRequestException('Catalog item is not active');
    if (item.stockQty <= 0) throw new BadRequestException('Catalog item is out of stock');

    const profiles = await this.cim.profilesForAuthUser(principal.userId);
    const profile = profiles.find(
      (candidate) => candidate.branchId === item.branchId && candidate.accountType === 'household',
    );
    if (!profile) throw new NotFoundException('Catalog item not found');
    const account = await this.accounts.findOne({
      where: { customerId: profile.id, branchId: item.branchId },
    });
    if (!account) throw new BadRequestException('Insufficient points.');
    await this.expireHouseholdAccount(account.id);
    const current = await this.accounts.findOneOrFail({ where: { id: account.id } });
    if (current.pointsBalance < item.pointsCost) {
      throw new BadRequestException('Insufficient points.');
    }

    const now = new Date();
    const dualAuth = await this.isDualAuth(item.branchId);
    return this.dataSource.transaction(async (manager) => {
      const redemption = await manager.save(
        Redemption,
        manager.create(Redemption, {
          branchId: item.branchId,
          customerId: profile.id,
          track: HOUSEHOLD_TRACK,
          catalogItemId: item.id,
          rewardDescription: item.name,
          pointsSpent: item.pointsCost,
          status: 'pending',
          requestedAt: now,
          approvedBy: null,
          approvedAt: null,
          rejectedReason: null,
          fulfilledAt: null,
          redemptionCode: null,
          createdAt: now,
          updatedAt: now,
        }),
      );
      if (!dualAuth) {
        const code = await this.settleHouseholdApprovalInTx(
          manager,
          redemption,
          principal.userId,
          now,
          item.branchId,
        );
        redemption.status = 'approved';
        redemption.approvedBy = principal.userId;
        redemption.approvedAt = now;
        redemption.redemptionCode = code;
        redemption.updatedAt = now;
      }
      return redemption;
    });
  }

  /** Customer commercial redemption for one owned branch account. */
  async createCustomerCommercialRedemption(
    principal: Principal,
    branchId: string,
  ): Promise<Redemption> {
    if (principal.accountType !== 'commercial') {
      throw new ForbiddenException('This account does not use commercial rewards');
    }
    const profiles = await this.cim.profilesForAuthUser(principal.userId);
    const profile = profiles.find(
      (candidate) => candidate.branchId === branchId && candidate.accountType === 'commercial',
    );
    if (!profile) throw new NotFoundException('Commercial loyalty account not found');
    const account = await this.commercialAccounts.findOne({
      where: { customerId: profile.id, branchId },
    });
    if (!account || account.completedCycles < 1) {
      throw new BadRequestException('No completed cycle available to redeem yet');
    }

    const now = new Date();
    const dualAuth = await this.isDualAuth(branchId);
    return this.dataSource.transaction(async (manager) => {
      const redemption = await manager.save(
        Redemption,
        manager.create(Redemption, {
          branchId,
          customerId: profile.id,
          track: COMMERCIAL_TRACK,
          catalogItemId: null,
          rewardDescription: COMMERCIAL_REWARD,
          pointsSpent: null,
          status: 'pending',
          requestedAt: now,
          approvedBy: null,
          approvedAt: null,
          rejectedReason: null,
          fulfilledAt: null,
          redemptionCode: null,
          createdAt: now,
          updatedAt: now,
        }),
      );
      if (!dualAuth) {
        const code = await this.settleCommercialApprovalInTx(
          manager,
          redemption,
          principal.userId,
          now,
        );
        redemption.status = 'approved';
        redemption.approvedBy = principal.userId;
        redemption.approvedAt = now;
        redemption.redemptionCode = code;
        redemption.updatedAt = now;
      }
      return redemption;
    });
  }

  private async expireHouseholdAccount(accountId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const account = await manager.findOne(HouseholdLoyaltyAccount, {
        where: { id: accountId },
        lock: { mode: 'pessimistic_write' },
      });
      if (account) await this.expireHouseholdPointsInTx(manager, account, new Date());
    });
  }

  /** Apply due expiry once per earn row. Redemptions consume the oldest earn lots
   * first; positive legacy adjustments remain non-expiring. */
  private async expireHouseholdPointsInTx(
    manager: EntityManager,
    account: HouseholdLoyaltyAccount,
    now: Date,
  ): Promise<void> {
    const transactions = await manager.find(HouseholdPointTransaction, {
      where: { accountId: account.id },
      order: { createdAt: 'ASC' },
    });
    const lots: Array<{
      id: string;
      remaining: number;
      expiresAt: Date | null;
      expired: boolean;
    }> = [];

    for (const transaction of transactions) {
      if (transaction.type === 'earn' && transaction.pointsDelta > 0) {
        lots.push({
          id: transaction.id,
          remaining: transaction.pointsDelta,
          expiresAt: transaction.expiresAt,
          expired: false,
        });
        continue;
      }
      if (transaction.type === 'expire' && transaction.sourcePointTransactionId) {
        const source = lots.find((lot) => lot.id === transaction.sourcePointTransactionId);
        if (source) {
          source.remaining = 0;
          source.expired = true;
        }
        continue;
      }
      if (transaction.pointsDelta >= 0) continue;
      let debit = -transaction.pointsDelta;
      for (const lot of lots) {
        if (debit === 0) break;
        const consumed = Math.min(lot.remaining, debit);
        lot.remaining -= consumed;
        debit -= consumed;
      }
    }

    let availableToExpire = account.pointsBalance;
    let expiredTotal = 0;
    for (const lot of lots) {
      if (
        lot.expired ||
        lot.remaining <= 0 ||
        !lot.expiresAt ||
        lot.expiresAt.getTime() > now.getTime() ||
        availableToExpire <= 0
      ) {
        continue;
      }
      const amount = Math.min(lot.remaining, availableToExpire);
      await manager.save(
        HouseholdPointTransaction,
        manager.create(HouseholdPointTransaction, {
          accountId: account.id,
          customerId: account.customerId,
          branchId: account.branchId,
          type: 'expire',
          pointsDelta: -amount,
          sourceServiceRequestId: null,
          redemptionId: null,
          sourcePointTransactionId: lot.id,
          earnedAt: null,
          expiresAt: null,
          createdAt: now,
        }),
      );
      availableToExpire -= amount;
      expiredTotal += amount;
    }
    if (expiredTotal === 0) return;

    await manager.update(
      HouseholdLoyaltyAccount,
      { id: account.id },
      { pointsBalance: account.pointsBalance - expiredTotal, updatedAt: now },
    );
    account.pointsBalance -= expiredTotal;
    account.updatedAt = now;
  }
}
