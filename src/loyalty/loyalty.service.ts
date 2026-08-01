import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { Principal } from '../auth/principal';
import { CimService } from '../cim/cim.service';
import { CatalogItem } from './catalog-item.entity';
import { HouseholdLoyaltyAccount } from './household-loyalty-account.entity';
import { HouseholdPointTransaction } from './household-point-transaction.entity';
import { Redemption } from './redemption.entity';
import { CreateRedemptionDto } from './dto/create-redemption.dto';
import { RejectRedemptionDto } from './dto/reject-redemption.dto';
import { ListRedemptionsQuery } from './dto/list-redemptions.query';

/** The household track — this slice never touches the commercial track (AGENTS.md
 * §8a: the two tracks are separate and must not be merged). Every query filters
 * on this. Value must match the DB CHECK constraint redemptions_track_check
 * (allowed: 'household_points' | 'commercial_30plus1'). */
const HOUSEHOLD_TRACK = 'household_points';

/** A redemption enriched for the approval queue UI: the row plus the resolved
 * customer name, the catalog reward name (if any), and the household account's
 * current balance. The controller flattens this into the snake_case list row. */
export interface RedemptionListItem {
  redemption: Redemption;
  customerName: string | null;
  catalogItemName: string | null;
  pointsBalance: number | null;
}

/**
 * Household loyalty redemption workflow (LPM module, household track only —
 * AGENTS.md §8a). This slice is the Branch Manager dual-authorization gate
 * (BM-US-03): read the reward catalog, seed a pending request, then approve /
 * reject / fulfill it. The commercial track (30+1 free cylinder) is a separate
 * slice and is never read or written here.
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
    // The approval flow mutates redemption + catalog stock + account balance +
    // ledger atomically, so it needs a transaction that spans all four.
    private readonly dataSource: DataSource,
    // Reused to validate the customer link at request time — the same cross-module
    // reuse the SRD service applies (CimService.findInBranch). LPM → CIM only, so
    // there is no module cycle.
    private readonly cim: CimService,
  ) {}

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
      order: { name: 'ASC' },
    });
  }

  /**
   * The approval queue: household redemptions for the caller's branch(es), newest
   * first, optionally narrowed to one lifecycle state (default 'pending'; 'all'
   * drops the status filter). Each row is enriched with the customer name, the
   * catalog reward name, and the account's current balance so the queue UI can
   * render without extra round-trips. Branch + track scope come from the
   * principal / this slice, never from request input (AGENTS.md §5).
   */
  async listRedemptions(
    principal: Principal,
    query: ListRedemptionsQuery,
  ): Promise<RedemptionListItem[]> {
    const branchIds = this.requireBranches(principal);

    // Default to the actionable queue; 'all' means "no status filter".
    const status = query.status ?? 'pending';
    const redemptions = await this.redemptions.find({
      where: {
        branchId: In(branchIds),
        track: HOUSEHOLD_TRACK,
        ...(status === 'all' ? {} : { status }),
      },
      order: { requestedAt: 'DESC' },
    });
    if (redemptions.length === 0) return [];

    // Batch-resolve the three enrichments in bulk (no per-row N+1). All lookups
    // stay scoped to the caller's branch(es).
    const customerIds = [...new Set(redemptions.map((r) => r.customerId))];
    const catalogItemIds = [
      ...new Set(
        redemptions
          .map((r) => r.catalogItemId)
          .filter((id): id is string => id !== null),
      ),
    ];

    const [customerNames, catalogNames, balances] = await Promise.all([
      this.customerNames(branchIds, customerIds),
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
    const redemption = this.redemptions.create({
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
      createdAt: now,
      updatedAt: now,
    });

    return this.redemptions.save(redemption);
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
      const pointsSpent = redemption.pointsSpent ?? 0;

      // (a) Commit the state transition first, race-safe. Only a still-pending row
      //     in scope is updated; 0 rows => a concurrent approve/reject already won.
      const approved = await manager
        .createQueryBuilder()
        .update(Redemption)
        .set({
          status: 'approved',
          approvedBy: principal.userId,
          approvedAt: now,
          updatedAt: now,
        })
        .where(
          'id = :id AND branch_id IN (:...branchIds) AND track = :track AND status = :status',
          { id, branchIds, track: HOUSEHOLD_TRACK, status: 'pending' },
        )
        .execute();
      if (!approved.affected) {
        throw new ConflictException('Redemption is not pending');
      }

      // (b) Re-read the account (fast, clear error). The authoritative debit guard
      //     is the conditional UPDATE in (d).
      const account = await manager.findOne(HouseholdLoyaltyAccount, {
        where: { customerId: redemption.customerId, branchId: redemption.branchId },
      });
      if (!account) {
        throw new ConflictException('Loyalty account not found');
      }
      if (account.pointsBalance < pointsSpent) {
        throw new ConflictException('insufficient points');
      }

      // (c) Decrement stock, race-safe, only when a catalog item is linked (the
      //     household track always links one; guard defensively). 0 rows => the
      //     last unit was taken concurrently.
      if (redemption.catalogItemId) {
        const stock = await manager
          .createQueryBuilder()
          .update(CatalogItem)
          .set({ stockQty: () => 'stock_qty - 1', updatedAt: now })
          .where(
            'id = :id AND branch_id IN (:...branchIds) AND stock_qty > 0',
            { id: redemption.catalogItemId, branchIds },
          )
          .execute();
        if (!stock.affected) {
          throw new ConflictException('out of stock');
        }
      }

      // (d) Debit the balance, race-safe against a concurrent approval on the same
      //     account. pointsSpent is a trusted integer (snapshot from our own DB),
      //     so inlining it in the SET expression carries no injection risk. 0 rows
      //     => the balance dropped below the cost between (b) and here => 409.
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
          earnedAt: null,
          expiresAt: null,
          createdAt: now,
        }),
      );

      // Reflect the committed state back to the caller without a re-read.
      redemption.status = 'approved';
      redemption.approvedBy = principal.userId;
      redemption.approvedAt = now;
      redemption.updatedAt = now;
      return redemption;
    });
  }

  /**
   * Reject a pending household redemption (BM-US-03). Records who actioned it
   * (approved_by / approved_at) and the reason (rejected_reason). No points or
   * stock change — a rejected request never debits. The pending→rejected
   * transition is race-safe: 0 rows affected (already approved / rejected, or a
   * concurrent action won) => 409.
   */
  async rejectRedemption(
    principal: Principal,
    id: string,
    dto: RejectRedemptionDto,
  ): Promise<Redemption> {
    const branchIds = this.requireBranches(principal);

    // Load scoped to branch + household track — 404 if missing / out of scope.
    const redemption = await this.redemptions.findOne({
      where: { id, branchId: In(branchIds), track: HOUSEHOLD_TRACK },
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
        'id = :id AND branch_id IN (:...branchIds) AND track = :track AND status = :status',
        { id, branchIds, track: HOUSEHOLD_TRACK, status: 'pending' },
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
   * Mark an approved household redemption fulfilled (BM-US-03) — the reward has
   * been physically handed over. Stamps fulfilled_at. The approved→fulfilled
   * transition is race-safe: 0 rows affected (still pending, already fulfilled,
   * or rejected) => 409.
   */
  async fulfillRedemption(
    principal: Principal,
    id: string,
  ): Promise<Redemption> {
    const branchIds = this.requireBranches(principal);

    // Load scoped to branch + household track — 404 if missing / out of scope.
    const redemption = await this.redemptions.findOne({
      where: { id, branchId: In(branchIds), track: HOUSEHOLD_TRACK },
    });
    if (!redemption) throw new NotFoundException('Redemption not found');

    const now = new Date();
    const result = await this.redemptions
      .createQueryBuilder()
      .update(Redemption)
      .set({ status: 'fulfilled', fulfilledAt: now, updatedAt: now })
      .where(
        'id = :id AND branch_id IN (:...branchIds) AND track = :track AND status = :status',
        { id, branchIds, track: HOUSEHOLD_TRACK, status: 'approved' },
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
    return new Map(
      accounts.map((a) => [this.accountKey(a.customerId, a.branchId), a.pointsBalance]),
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
}
