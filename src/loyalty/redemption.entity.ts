import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Lifecycle of a loyalty redemption. Household track (this slice):
 *   pending → approved → fulfilled   (the happy path)
 *   pending → rejected               (Branch Manager declines)
 * The pending→{approved,rejected} gate is the Branch Manager dual-authorization
 * step (AGENTS.md §8a); fulfilled marks the reward physically handed over.
 */
export type RedemptionStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'fulfilled'
  | 'cancelled';

/**
 * Maps loyalty.redemptions — one row per reward redemption request. There are two
 * SEPARATE loyalty tracks (AGENTS.md §8a) distinguished by the `track` column;
 * this slice handles track='household' ONLY, so every query filters on it and the
 * commercial track is never touched here.
 *
 * The table ALREADY EXISTS in the shared schema — this entity only maps it, no
 * migration is added. There is NO deleted_at on this table (a redemption is
 * closed via status, not soft-deleted). No FK constraints by design (AGENTS.md
 * §6); branch_id / customer_id / catalog_item_id / approved_by are logical
 * references validated in the service layer.
 */
@Entity({ schema: 'loyalty', name: 'redemptions' })
export class Redemption {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Tenancy handle — server-derived scope, never trusted from the client
   * (AGENTS.md §5). */
  @Column({ name: 'branch_id', type: 'uuid' })
  branchId!: string;

  /** The CIM customer redeeming (cim.customers id). */
  @Column({ name: 'customer_id', type: 'uuid' })
  customerId!: string;

  /** 'household' | 'commercial'. This slice only ever reads/writes 'household'. */
  @Column({ type: 'text' })
  track!: string;

  /** The catalog reward being redeemed (loyalty.catalog_items id). Null for the
   * commercial track's free-cylinder reward, which has no catalog item. */
  @Column({ name: 'catalog_item_id', type: 'uuid', nullable: true })
  catalogItemId!: string | null;

  /** Point-in-time snapshot of the reward name at request time, so the queue
   * still shows what was requested even if the catalog item later changes. */
  @Column({ name: 'reward_description', type: 'text', nullable: true })
  rewardDescription!: string | null;

  /** Point-in-time snapshot of the points cost at request time. Debited from the
   * account on approval. */
  @Column({ name: 'points_spent', type: 'int', nullable: true })
  pointsSpent!: number | null;

  @Column({ type: 'text', default: 'pending' })
  status!: RedemptionStatus;

  @Column({ name: 'requested_at', type: 'timestamptz' })
  requestedAt!: Date;

  /** The Branch Manager (auth user id) who approved OR rejected. Set on both
   * actions to record who actioned the request. */
  @Column({ name: 'approved_by', type: 'uuid', nullable: true })
  approvedBy!: string | null;

  /** When the approve/reject decision was made. */
  @Column({ name: 'approved_at', type: 'timestamptz', nullable: true })
  approvedAt!: Date | null;

  /** Reason captured when a Branch Manager rejects. Null unless rejected. */
  @Column({ name: 'rejected_reason', type: 'text', nullable: true })
  rejectedReason!: string | null;

  /** When the reward was physically handed over (approved → fulfilled). */
  @Column({ name: 'fulfilled_at', type: 'timestamptz', nullable: true })
  fulfilledAt!: Date | null;

  /** The system-generated redemption code, issued when the request is approved
   * (BM-016/017). Null while pending/rejected/cancelled. Unique among issued codes
   * (partial unique index). The Branch Manager never types this — it is generated. */
  @Column({ name: 'redemption_code', type: 'text', nullable: true })
  redemptionCode!: string | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
