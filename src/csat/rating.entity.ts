import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Closed-loop state of a CSAT rating (journey BM-US-08). Every rating starts
 * 'Open'; the Branch Manager logs a resolution note and marks it 'Resolved',
 * which is what decrements the branch's Open Complaints KPI (story BM-041) and
 * what the Franchise Admin sees cross-branch (FA-US-04). DB CHECK-constrained, so
 * this union must stay in sync with ratings_resolution_status_check.
 */
export type ResolutionStatus = 'Open' | 'Resolved';

/**
 * Maps csat.ratings — one row per customer rating of a completed delivery
 * (CSAT Feedback & Analytics module). Ratings are SUBMITTED BY THE CUSTOMER on
 * mobile (customers are mobile-only, AGENTS.md §7) — this API never creates them,
 * it only reads them and records the Branch Manager's follow-up. `stars` is
 * 1–5 (DB CHECK); 1–3 is the "low CSAT" band the BM queue surfaces (story BM-038).
 *
 * The base table ALREADY EXISTS in the shared schema; migration 0018 added only
 * the four resolution_* columns. There is NO deleted_at (a rating is never
 * retired — it is feedback of record). No FK constraints by design (AGENTS.md §6);
 * branch_id / service_request_id / customer_id / resolved_by are logical
 * references validated in the service layer.
 */
@Entity({ schema: 'csat', name: 'ratings' })
export class Rating {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Tenancy handle — server-derived scope, never trusted from the client
   * (AGENTS.md §5). */
  @Column({ name: 'branch_id', type: 'uuid' })
  branchId!: string;

  /** The delivery this rating is about (srd.service_requests id). Drives the
   * "open the associated service request" step (story BM-039). */
  @Column({ name: 'service_request_id', type: 'uuid' })
  serviceRequestId!: string;

  /** The CIM customer who submitted the rating. */
  @Column({ name: 'customer_id', type: 'uuid' })
  customerId!: string;

  /** 1–5 (DB CHECK). 1–3 is the low-CSAT band flagged for follow-up (BM-038). */
  @Column({ type: 'int' })
  stars!: number;

  /** The customer's free-text feedback. Null when they rated without commenting. */
  @Column({ type: 'text', nullable: true })
  comment!: string | null;

  @Column({ name: 'submitted_at', type: 'timestamptz' })
  submittedAt!: Date;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  /** 'Open' until the Branch Manager closes the loop (story BM-041). */
  @Column({ name: 'resolution_status', type: 'text', default: 'Open' })
  resolutionStatus!: ResolutionStatus;

  /** What the Branch Manager did about it (story BM-040). Null while Open. */
  @Column({ name: 'resolution_note', type: 'text', nullable: true })
  resolutionNote!: string | null;

  /** The Branch Manager (auth user id) who resolved it — the identity half of
   * BM-041's "with Branch Manager identity and timestamp". Null while Open. */
  @Column({ name: 'resolved_by', type: 'uuid', nullable: true })
  resolvedBy!: string | null;

  /** When the loop was closed. Null while Open. */
  @Column({ name: 'resolved_at', type: 'timestamptz', nullable: true })
  resolvedAt!: Date | null;
}
