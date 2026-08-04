import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Maps loyalty.commercial_purchase_records — the audit trail of counted cylinder
 * purchases for the commercial "30+1" track. Each row is one purchase counted
 * toward a cycle (cycle_number = which 30-purchase cycle it belongs to). The
 * earning side (writing these rows as deliveries complete) is a separate slice;
 * this slice READS them only, to render the customer's ledger history on the
 * redemption review screen (BM-014).
 *
 * The table ALREADY EXISTS in the shared schema — this entity only maps it, no
 * migration. No FK constraints by design (AGENTS.md §6).
 */
@Entity({ schema: 'loyalty', name: 'commercial_purchase_records' })
export class CommercialPurchaseRecord {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'account_id', type: 'uuid' })
  accountId!: string;

  @Column({ name: 'customer_id', type: 'uuid' })
  customerId!: string;

  @Column({ name: 'branch_id', type: 'uuid' })
  branchId!: string;

  /** The delivery this purchase was counted from (srd.service_requests id). */
  @Column({ name: 'service_request_id', type: 'uuid' })
  serviceRequestId!: string;

  /** Which 30-purchase cycle this record belongs to (1-based). */
  @Column({ name: 'cycle_number', type: 'int' })
  cycleNumber!: number;

  @Column({ name: 'counted_at', type: 'timestamptz' })
  countedAt!: Date;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
