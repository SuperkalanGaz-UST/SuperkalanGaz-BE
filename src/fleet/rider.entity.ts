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
 * Delivery Rider mobile experience handles invitation acceptance, availability,
 * offer acceptance, milestones, and foreground operational phone location. These
 * phone coordinates support dispatch only; authoritative vehicle location remains
 * SinoTrack ST-901 → Traccar for Fleet geofencing and PMS.
 * Invitation acceptance creates new roster rows as Offline and unassigned.
 * Soft delete only (AGENTS.md §3.2): deleted_at marks a Delivery Rider retired;
 * this API never hard-deletes.
 */
@Entity({ schema: 'fleet', name: 'riders' })
export class Rider {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Supabase Auth identity for invitation-provisioned Delivery Riders. */
  @Column({ name: 'auth_user_id', type: 'uuid', nullable: true })
  authUserId!: string | null;

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

  /** Latest foreground phone position for Service Request and dispatch operations.
   * These fields are deliberately separate from vehicle/Traccar telemetry. */
  @Column({ name: 'operational_latitude', type: 'double precision', nullable: true })
  operationalLatitude!: number | null;

  @Column({ name: 'operational_longitude', type: 'double precision', nullable: true })
  operationalLongitude!: number | null;

  @Column({ name: 'operational_accuracy_m', type: 'real', nullable: true })
  operationalAccuracyM!: number | null;

  @Column({ name: 'operational_location_captured_at', type: 'timestamptz', nullable: true })
  operationalLocationCapturedAt!: Date | null;

  @Column({ name: 'operational_location_received_at', type: 'timestamptz', nullable: true })
  operationalLocationReceivedAt!: Date | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}
