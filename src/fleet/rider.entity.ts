import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** Availability state of a rider. Drives the dispatch dropdown: only
 * 'Available' riders can be assigned. A rider flips to 'On Delivery' on dispatch
 * and returns to 'Available' when the order is marked delivered (Slice 3).
 * 'Maintenance Due' / 'Offline' are set out-of-band (manual seeding for now). */
export type RiderStatus =
  | 'Available'
  | 'On Delivery'
  | 'Maintenance Due'
  | 'Offline';

/** The set of statuses, reused by the query-filter validator so the allowed set
 * lives in one place. */
export const RIDER_STATUSES: readonly RiderStatus[] = [
  'Available',
  'On Delivery',
  'Maintenance Due',
  'Offline',
];

/**
 * Maps fleet.riders — one row per Delivery Rider a branch can dispatch to. The
 * planned Delivery Rider mobile experience handles invitation acceptance,
 * availability, offer acceptance, and milestones; it does not supply authoritative
 * GPS. Live tracking remains SinoTrack ST-901 → Traccar and is deferred in this slice.
 * Seeded manually for now — Rider onboarding is not implemented in this slice. Soft
 * delete only (AGENTS.md §3.2): deleted_at marks a Delivery Rider retired; this API never
 * hard-deletes.
 */
@Entity({ schema: 'fleet', name: 'riders' })
export class Rider {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Tenancy handle — a rider belongs to exactly one branch. No FK by design
   * (AGENTS.md §6); the service validates the branch/rider relationship. */
  @Column({ name: 'branch_id', type: 'uuid' })
  branchId!: string;

  @Column({ type: 'text' })
  name!: string;

  /** Motorcycle plate, shown next to the rider name in the dispatch dropdown. */
  @Column({ type: 'text' })
  plate!: string;

  @Column({ type: 'text', default: 'Available' })
  status!: RiderStatus;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}
