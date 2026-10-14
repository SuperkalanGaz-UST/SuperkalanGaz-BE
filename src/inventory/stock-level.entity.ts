import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Maps inventory.stock_levels — one row per (branch, product) with any
 * recorded stock. product_id is a logical reference to srd.products (the
 * same shared LPG catalog Orders uses for cylinder sizes); this module does
 * not maintain its own product list. Soft delete only (AGENTS.md §3.2).
 */
@Entity({ schema: 'inventory', name: 'stock_levels' })
export class StockLevel {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'branch_id', type: 'uuid' })
  branchId!: string;

  @Column({ name: 'product_id', type: 'uuid' })
  productId!: string;

  @Column({ name: 'current_qty', type: 'int', default: 0 })
  currentQty!: number;

  @Column({ name: 'threshold_qty', type: 'int', default: 10 })
  thresholdQty!: number;

  @Column({ name: 'capacity_qty', type: 'int', default: 100 })
  capacityQty!: number;

  /** Who last recorded a stock intake against this row. Null until the first
   * intake — a row can exist with only its server-side defaults. */
  @Column({ name: 'updated_by', type: 'uuid', nullable: true })
  updatedBy!: string | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}
