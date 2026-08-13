import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** Issue type on a complaint. DB CHECK-constrained (incidents_category_check),
 * so this union must stay in sync. 'lost_cylinder' was added by migration 0019
 * for this journey (BM-US-04); the other four pre-date it. */
export type IncidentCategory =
  | 'late_delivery'
  | 'wrong_item'
  | 'safety'
  | 'billing'
  | 'lost_cylinder'
  | 'other';

/** Lifecycle of an incident. DB CHECK-constrained (incidents_status_check). This
 * slice (BM-US-04) only ever writes 'open' — there is no resolve/close AC in the
 * journey's granular stories, so no transition out of 'open' is built here. */
export type IncidentStatus = 'open' | 'in_progress' | 'resolved' | 'closed';

/** DB CHECK-constrained (incidents_priority_check). Not exposed as a form field
 * in this slice (no AC calls for a priority selector) — every incident this API
 * creates defaults to 'medium'. */
export type IncidentPriority = 'low' | 'medium' | 'high';

/**
 * Maps csat.incidents — one row per complaint the Branch Manager logs against a
 * Service Request (journey BM-US-04, "Log a Lost or Undelivered Cylinder
 * Report"). Unlike csat.ratings (customer-submitted), incidents are logged BY
 * the Branch Manager — this is the only writer.
 *
 * The base table ALREADY EXISTS in the shared schema; migration 0019 widened
 * `category` to add 'lost_cylinder' and added the `escalated` / `escalated_at`
 * columns for story BM-022. There is NO deleted_at (an incident is never
 * retired — it is a record of what was reported). No FK constraints by design
 * (AGENTS.md §6); branch_id / customer_id / service_request_id / assigned_to are
 * logical references validated in the service layer.
 */
@Entity({ schema: 'csat', name: 'incidents' })
export class Incident {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Tenancy handle — server-derived scope, never trusted from the client
   * (AGENTS.md §5). */
  @Column({ name: 'branch_id', type: 'uuid' })
  branchId!: string;

  /** The affected customer (cim.customers id), copied from the linked Service
   * Request at the moment the complaint is logged. */
  @Column({ name: 'customer_id', type: 'uuid', nullable: true })
  customerId!: string | null;

  /** The delivery this complaint is about (srd.service_requests id). Always
   * populated by this API — BM-019's whole premise is locating this SR first. */
  @Column({ name: 'service_request_id', type: 'uuid', nullable: true })
  serviceRequestId!: string | null;

  @Column({ type: 'text' })
  category!: IncidentCategory;

  /** The Branch Manager's free-text account of the incident — satisfies both the
   * complaint's description (consolidated AC2) and BM-020's "resolution note"
   * (the same text, not a separate later step; see PR notes). */
  @Column({ type: 'text' })
  description!: string;

  @Column({ type: 'text', default: 'open' })
  status!: IncidentStatus;

  @Column({ type: 'text', default: 'medium' })
  priority!: IncidentPriority;

  @Column({ name: 'reported_at', type: 'timestamptz' })
  reportedAt!: Date;

  @Column({ name: 'first_response_at', type: 'timestamptz', nullable: true })
  firstResponseAt!: Date | null;

  @Column({ name: 'resolved_at', type: 'timestamptz', nullable: true })
  resolvedAt!: Date | null;

  @Column({ name: 'assigned_to', type: 'uuid', nullable: true })
  assignedTo!: string | null;

  @Column({ name: 'resolution_note', type: 'text', nullable: true })
  resolutionNote!: string | null;

  /** Whether this incident has been flagged as escalated outside the system
   * (story BM-022). The system records the flag ONLY — no external automation,
   * no notifications. Added by migration 0019. */
  @Column({ type: 'boolean', default: false })
  escalated!: boolean;

  /** When the escalation flag was set. Null while not escalated. */
  @Column({ name: 'escalated_at', type: 'timestamptz', nullable: true })
  escalatedAt!: Date | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
