import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Maps loyalty.household_loyalty_accounts — one row per (customer, branch) holding
 * that household's current points balance (AGENTS.md §8a household track). The
 * balance is the running total of the household_point_transactions ledger; it is
 * decremented (race-safe) when a redemption is approved.
 *
 * The table ALREADY EXISTS in the shared schema — this entity only maps it, no
 * migration is added. There is NO deleted_at on this table. No FK constraints by
 * design (AGENTS.md §6); customer_id / branch_id are logical references validated
 * in the service layer.
 */
@Entity({ schema: 'loyalty', name: 'household_loyalty_accounts' })
export class HouseholdLoyaltyAccount {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The CIM customer (cim.customers id) this account belongs to. */
  @Column({ name: 'customer_id', type: 'uuid' })
  customerId!: string;

  /** Tenancy handle — the branch the account is scoped to (AGENTS.md §5). */
  @Column({ name: 'branch_id', type: 'uuid' })
  branchId!: string;

  /** Current spendable balance. Never allowed to go negative — approval uses a
   * conditional UPDATE (WHERE points_balance >= spent). */
  @Column({ name: 'points_balance', type: 'int', default: 0 })
  pointsBalance!: number;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
