import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Maps loyalty.commercial_loyalty_accounts — one row per (customer, branch) for the
 * commercial "30+1" track (AGENTS.md §8a): every 30 counted cylinder purchases
 * complete a cycle, earning one free cylinder. current_cycle_count is progress
 * toward the next free cylinder (0–30, DB CHECK-constrained); completed_cycles is
 * the number of EARNED-but-not-yet-redeemed free cylinders. This slice only reads
 * current_cycle_count and DECREMENTS completed_cycles when a redemption is approved
 * — the earning side (counting purchases, rolling a cycle over at 30) is a separate
 * slice and is never written here.
 *
 * The table ALREADY EXISTS in the shared schema — this entity only maps it, no
 * migration is added. There is NO deleted_at. No FK constraints by design
 * (AGENTS.md §6); customer_id / branch_id are logical references validated in the
 * service layer.
 */
@Entity({ schema: 'loyalty', name: 'commercial_loyalty_accounts' })
export class CommercialLoyaltyAccount {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The CIM customer (cim.customers id) this account belongs to. */
  @Column({ name: 'customer_id', type: 'uuid' })
  customerId!: string;

  /** Tenancy handle — the branch the account is scoped to (AGENTS.md §5). */
  @Column({ name: 'branch_id', type: 'uuid' })
  branchId!: string;

  /** Progress toward the next free cylinder, 0–30 (DB CHECK). Read-only here —
   * advanced by the earning slice, not by redemption. */
  @Column({ name: 'current_cycle_count', type: 'int', default: 0 })
  currentCycleCount!: number;

  /** Earned free cylinders not yet redeemed. Redemption approval decrements this
   * (race-safe, WHERE completed_cycles >= 1); never allowed below zero. */
  @Column({ name: 'completed_cycles', type: 'int', default: 0 })
  completedCycles!: number;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
