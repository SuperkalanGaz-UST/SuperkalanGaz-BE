import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Maps loyalty.household_point_transactions — the append-only points ledger for
 * the household track (AGENTS.md §8a "digital ledger"). One row per points
 * movement; the account's points_balance is the sum of these deltas. This slice
 * writes exactly one kind of row: a 'redeem' entry (negative points_delta, with
 * redemption_id set) inserted inside the approval transaction.
 *
 * The table ALREADY EXISTS in the shared schema — this entity only maps it, no
 * migration is added. Ledger rows are immutable: never updated or deleted. No FK
 * constraints by design (AGENTS.md §6); all *_id columns are logical references.
 */
@Entity({ schema: 'loyalty', name: 'household_point_transactions' })
export class HouseholdPointTransaction {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The account (loyalty.household_loyalty_accounts id) this movement belongs to. */
  @Column({ name: 'account_id', type: 'uuid' })
  accountId!: string;

  /** Denormalized customer scope, so the ledger can be read without a join. */
  @Column({ name: 'customer_id', type: 'uuid' })
  customerId!: string;

  /** Denormalized branch scope (tenancy handle, AGENTS.md §5). */
  @Column({ name: 'branch_id', type: 'uuid' })
  branchId!: string;

  /** Movement kind. This slice only writes 'redeem'; 'earn'/'expire' are other
   * slices (point accrual on delivery, 12-month expiry). */
  @Column({ type: 'text' })
  type!: string;

  /** Signed change to the balance. Negative for a 'redeem' (points spent). */
  @Column({ name: 'points_delta', type: 'int' })
  pointsDelta!: number;

  /** The Service Request that earned these points, for an 'earn' row. Null for a
   * redemption. */
  @Column({ name: 'source_service_request_id', type: 'uuid', nullable: true })
  sourceServiceRequestId!: string | null;

  /** The redemption this movement settles, for a 'redeem' row. Null otherwise. */
  @Column({ name: 'redemption_id', type: 'uuid', nullable: true })
  redemptionId!: string | null;

  /** When the points were earned (earn rows). Null for a redemption. */
  @Column({ name: 'earned_at', type: 'timestamptz', nullable: true })
  earnedAt!: Date | null;

  /** 12-month expiry horizon for earned points (AGENTS.md §8a). Null for a
   * redemption. */
  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt!: Date | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
