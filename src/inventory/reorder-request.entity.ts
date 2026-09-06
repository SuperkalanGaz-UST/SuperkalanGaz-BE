import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

export const REORDER_REQUEST_STATUSES = ['Pending', 'Approved', 'Delivered', 'Cancelled'] as const;
export type ReorderRequestStatus = (typeof REORDER_REQUEST_STATUSES)[number];

@Entity({ schema: 'inventory', name: 'reorder_requests' })
export class ReorderRequest {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'branch_id', type: 'uuid' })
  branchId!: string;

  @Column({ name: 'product_id', type: 'uuid' })
  productId!: string;

  @Column({ name: 'requested_qty', type: 'int' })
  requestedQty!: number;

  @Column({ type: 'text', default: 'Pending' })
  status!: ReorderRequestStatus;

  @Column({ name: 'requested_by', type: 'uuid' })
  requestedBy!: string;

  @Column({ name: 'requested_by_name', type: 'text' })
  requestedByName!: string;

  @Column({ name: 'requested_at', type: 'timestamptz' })
  requestedAt!: Date;

  @Column({ name: 'decided_at', type: 'timestamptz', nullable: true })
  decidedAt!: Date | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}
