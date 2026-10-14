import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

export const GOVERNANCE_REQUEST_TYPES = [
  'franchise-admin-account',
  'price-configuration',
  'sla-threshold',
  'branch-owner-change',
  'branch-account',
  'other',
] as const;

export type GovernanceRequestType = (typeof GOVERNANCE_REQUEST_TYPES)[number];
export type GovernanceRequestStatus =
  | 'pending'
  | 'applying'
  | 'approved'
  | 'rejected'
  | 'revision-requested';
export type GovernanceRisk = 'low' | 'medium' | 'high';

@Entity({ schema: 'core', name: 'governance_requests' })
export class GovernanceRequest {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text' })
  type!: GovernanceRequestType;

  @Column({ type: 'text', default: 'pending' })
  status!: GovernanceRequestStatus;

  @Column({ type: 'text' })
  title!: string;

  @Column({ type: 'text' })
  reason!: string;

  @Column({ name: 'risk_level', type: 'text', default: 'medium' })
  riskLevel!: GovernanceRisk;

  @Column({ name: 'branch_id', type: 'uuid', nullable: true })
  branchId!: string | null;

  @Column({ name: 'requested_by', type: 'uuid' })
  requestedBy!: string;

  @Column({ name: 'requested_by_name', type: 'text' })
  requestedByName!: string;

  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @Column({ name: 'submitted_at', type: 'timestamptz' })
  submittedAt!: Date;

  @Column({ name: 'decided_by', type: 'uuid', nullable: true })
  decidedBy!: string | null;

  @Column({ name: 'decided_by_name', type: 'text', nullable: true })
  decidedByName!: string | null;

  @Column({ name: 'decision_reason', type: 'text', nullable: true })
  decisionReason!: string | null;

  @Column({ name: 'decided_at', type: 'timestamptz', nullable: true })
  decidedAt!: Date | null;

  @Column({ name: 'applied_at', type: 'timestamptz', nullable: true })
  appliedAt!: Date | null;

  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}
