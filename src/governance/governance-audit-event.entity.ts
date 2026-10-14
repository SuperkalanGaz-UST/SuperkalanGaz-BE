import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

export const GOVERNANCE_AUDIT_CATEGORIES = [
  'approval',
  'admin-account',
  'price-change',
  'branch-owner-change',
  'sla-configuration',
  'security',
] as const;

export type GovernanceAuditCategory = (typeof GOVERNANCE_AUDIT_CATEGORIES)[number];

@Entity({ schema: 'core', name: 'governance_audit_events' })
export class GovernanceAuditEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text' })
  category!: GovernanceAuditCategory;

  @Column({ type: 'text' })
  action!: string;

  @Column({ name: 'actor_user_id', type: 'uuid' })
  actorUserId!: string;

  @Column({ name: 'actor_name', type: 'text' })
  actorName!: string;

  @Column({ name: 'actor_role', type: 'text' })
  actorRole!: 'super-admin' | 'franchise-admin' | 'branch-owner' | 'driver' | 'system';

  @Column({ name: 'affected_record_type', type: 'text' })
  affectedRecordType!: string;

  @Column({ name: 'affected_record_id', type: 'uuid', nullable: true })
  affectedRecordId!: string | null;

  @Column({ name: 'branch_id', type: 'uuid', nullable: true })
  branchId!: string | null;

  @Column({ name: 'governance_request_id', type: 'uuid', nullable: true })
  governanceRequestId!: string | null;

  @Column({ name: 'before_state', type: 'jsonb', nullable: true })
  beforeState!: Record<string, unknown> | null;

  @Column({ name: 'after_state', type: 'jsonb', nullable: true })
  afterState!: Record<string, unknown> | null;

  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  @Column({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt!: Date;

  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}
