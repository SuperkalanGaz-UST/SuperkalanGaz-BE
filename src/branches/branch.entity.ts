import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Delivery coverage area for a branch. Currently only hand-drawn polygons are
 * supported (the registration wizard's "Draw on map"); `points` are [lat, lng]
 * vertices. Stored as jsonb; null means no coverage set.
 */
export interface BranchGeofence {
  type: 'polygon';
  points: [number, number][];
}

export interface LoyaltyPointRates {
  '2.7kg': number;
  '5kg': number;
  '11kg': number;
  '22kg': number;
  '50kg': number;
}

/**
 * Maps core.branches — one row per registered franchise branch, created by the
 * Franchise Admin "Register new branch account" flow. Lives in the `core` schema
 * per the 7-schema design (AGENTS.md §6).
 *
 * Soft delete is via `status` ('active' | 'inactive') — this table has no
 * deleted_at; retiring a branch flips it inactive (AGENTS.md §3.2, never
 * hard-delete). `status` is guarded by a CHECK constraint in the DB, so its
 * union type below must stay in sync with it.
 *
 * The Franchise Administrator-assigned geofence is stored on this branch row.
 * Curfew is still deferred, while low-stock thresholds live per product on
 * inventory.stock_levels. Owner identity is not stored on the branch either: it
 * is provisioned into Supabase Auth (CRM claims in app_metadata) by the service.
 */
@Entity({ schema: 'core', name: 'branches' })
export class Branch {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text' })
  name!: string;

  /**
   * Stable branch identifier, auto-generated at registration (name slug + a
   * short unique suffix). Unique among live rows (branches_code_active_uq).
   */
  @Column({ type: 'text' })
  code!: string;

  @Column({ type: 'text', nullable: true })
  region!: string | null;

  @Column({ type: 'text', nullable: true })
  address!: string | null;

  @Column({ name: 'contact_number', type: 'text', nullable: true })
  contactNumber!: string | null;

  /**
   * Editable default that may originate from a known_store_locations autofill
   * (added in migration 0004). Nullable — one reference row has no province.
   */
  @Column({ type: 'text', nullable: true })
  province!: string | null;

  /** Left blank-but-editable on autofill; never fabricated from the address. */
  @Column({ type: 'text', nullable: true })
  city!: string | null;

  /** Soft-delete flag (AGENTS.md §3.2). DB CHECK: 'active' | 'inactive'. */
  @Column({ type: 'text', default: 'active' })
  status!: 'active' | 'inactive';

  /**
   * The core.known_store_locations row this branch was provisioned from; null
   * for free-text registrations. Sole basis for "already registered" detection
   * in the registration combobox (never name/address). No FK by design
   * (AGENTS.md §6 — integrity enforced in the service layer).
   */
  @Column({ name: 'source_store_location_id', type: 'uuid', nullable: true })
  sourceStoreLocationId!: string | null;

  /** Delivery coverage polygon (added in migration 0006). Null = none set. */
  @Column({ type: 'jsonb', nullable: true })
  geofence!: BranchGeofence | null;

  /**
   * Loyalty Dual Authorization setting (added in migration 0016, story BM-013).
   * true (default) → customer redemption requests enter the Branch Manager's
   * pending Rewards Claiming queue for manual approve/reject. false → the branch
   * has delegated issuance: a request is auto-approved and coded immediately and
   * never appears in the queue.
   */
  @Column({ name: 'loyalty_dual_auth', type: 'boolean', default: true })
  loyaltyDualAuth!: boolean;

  /** Branch Owner-configured household points earned per delivered cylinder. */
  @Column({ name: 'loyalty_point_rates', type: 'jsonb' })
  loyaltyPointRates!: LoyaltyPointRates;

  /**
   * PMS interval in km (added in migration 0021, story BM-US-09): a vehicle is
   * flagged 'maintenance' once its odometer advances this far past its last
   * logged service. No config UI in this slice — DB default (3000) only.
   */
  @Column({ name: 'maintenance_threshold_km', type: 'int', default: 3000 })
  maintenanceThresholdKm!: number;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
