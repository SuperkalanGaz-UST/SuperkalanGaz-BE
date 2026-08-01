import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Maps loyalty.catalog_items — one row per household-track reward a Branch Owner
 * has configured for their branch (AGENTS.md §8a: the BO-configurable merchandise
 * catalog). A Branch Manager reads this catalog to build a redemption request and
 * to render reward names in the approval queue.
 *
 * The table ALREADY EXISTS in the shared schema (owned by the team's schema
 * pipeline); this entity only maps the existing columns — no migration is added.
 * There is NO deleted_at on this table: retirement is via is_active=false, not a
 * soft-delete timestamp (so "active catalog" filters on is_active, not deleted_at).
 * No FK constraints by design (AGENTS.md §6); branch_id / created_by are logical
 * references validated in the service layer.
 */
@Entity({ schema: 'loyalty', name: 'catalog_items' })
export class CatalogItem {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Tenancy handle — the branch this reward belongs to. Server-derived scope;
   * never trusted from the client (AGENTS.md §5). */
  @Column({ name: 'branch_id', type: 'uuid' })
  branchId!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  /** Points a household account must spend to redeem this reward. */
  @Column({ name: 'points_cost', type: 'int' })
  pointsCost!: number;

  /** On-hand stock. Decremented by one on redemption approval (race-safe,
   * conditional UPDATE) — never allowed below zero. */
  @Column({ name: 'stock_qty', type: 'int', default: 0 })
  stockQty!: number;

  /** Whether this reward is offered right now. The catalog endpoint returns only
   * is_active=true rows; retirement flips this false rather than deleting. */
  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  /** The auth user (Branch Owner) who created the item. Null for seeded/legacy
   * rows. No FK by design (AGENTS.md §6). */
  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy!: string | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
