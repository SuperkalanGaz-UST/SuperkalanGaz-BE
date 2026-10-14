import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** The three real SLA segments (matching the four timestamps: requested_at →
 * dispatched_at → in_transit_at → delivered_at), plus 'end_to_end' for a single
 * overall threshold. DB CHECK-constrained (sla_configurations_segment_check). */
export type SlaSegment =
  | 'request_to_dispatch'
  | 'dispatch_to_in_transit'
  | 'in_transit_to_delivery'
  | 'end_to_end';

/**
 * Maps core.sla_configurations — the Franchise Administrator's configured SLA
 * breach thresholds (BM-008's "configured breach threshold", explicitly
 * FA-owned per the story's own framing). This module is READ-ONLY against this
 * table: the Branch Manager reads thresholds to flag/record breaches but never
 * writes them — configuring the threshold is a separate FA-US story, out of
 * scope here (AGENTS.md §7 role split).
 *
 * The table ALREADY EXISTS in the shared schema — this entity only maps it, no
 * migration is added. `branch_id` null means a global default (applies to every
 * branch that has no branch-specific override); `order_source` 'all' means the
 * threshold applies regardless of channel — this slice only reads 'all' rows
 * (channel-specific thresholds are a different feature's concern). No FK
 * constraints by design (AGENTS.md §6).
 */
@Entity({ schema: 'core', name: 'sla_configurations' })
export class SlaConfiguration {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Null = global default; a specific branch's row overrides it for that
   * branch only. */
  @Column({ name: 'branch_id', type: 'uuid', nullable: true })
  branchId!: string | null;

  @Column({ type: 'text' })
  segment!: SlaSegment;

  /** 'mobile_app' | 'walk_in' | 'phone' | 'all'. This slice only reads 'all'
   * rows — see the class doc. */
  @Column({ name: 'order_source', type: 'text', default: 'all' })
  orderSource!: string;

  @Column({ name: 'threshold_minutes', type: 'int' })
  thresholdMinutes!: number;

  @Column({ name: 'set_by', type: 'uuid' })
  setBy!: string;

  @Column({ name: 'effective_from', type: 'timestamptz' })
  effectiveFrom!: Date;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
