import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Maps the existing srd.service_request_status_history table — an append-only
 * audit trail of Service Request lifecycle transitions and edits (BM-US-07).
 * One row is written per guarded action (edit, cancel, and later dispatch/
 * delivery slices may adopt it): it captures who changed what, when, and why.
 *
 * The table already exists in the schema (owned by the team's migration
 * pipeline), so this entity only maps it — no migration is added here. Like the
 * rest of SRD there are no FK constraints (AGENTS.md §6); service_request_id /
 * branch_id / changed_by are logical references validated in the service layer.
 * Rows are never updated or deleted — the history is immutable.
 */
@Entity({ schema: 'srd', name: 'service_request_status_history' })
export class ServiceRequestStatusHistory {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The Service Request this entry belongs to (srd.service_requests id). */
  @Column({ name: 'service_request_id', type: 'uuid' })
  serviceRequestId!: string;

  /** Denormalized branch scope of the parent request, so the audit trail can be
   * branch-filtered without a join (tenancy handle, AGENTS.md §5). */
  @Column({ name: 'branch_id', type: 'uuid' })
  branchId!: string;

  /** Status before the change. Null-safe: an intake-time entry may have none. */
  @Column({ name: 'from_status', type: 'text', nullable: true })
  fromStatus!: string | null;

  @Column({ name: 'to_status', type: 'text' })
  toStatus!: string;

  /** The principal (auth user id) who performed the change. */
  @Column({ name: 'changed_by', type: 'uuid' })
  changedBy!: string;

  @Column({ name: 'changed_at', type: 'timestamptz' })
  changedAt!: Date;

  /** Human-readable reason / summary: a cancel reason, or an old→new field diff
   * for an edit. Optional so status-only transitions can omit it. */
  @Column({ type: 'text', nullable: true })
  note!: string | null;
}
