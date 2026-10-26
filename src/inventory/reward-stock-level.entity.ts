import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** Display targets for branch rewards. Quantities stay in loyalty.catalog_items.stock_qty. */
@Entity({ schema: 'inventory', name: 'reward_stock_levels' })
export class RewardStockLevel {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'branch_id', type: 'uuid' })
  branchId!: string;

  @Column({ name: 'catalog_item_id', type: 'uuid' })
  catalogItemId!: string;

  @Column({ name: 'threshold_qty', type: 'int', default: 10 })
  thresholdQty!: number;

  @Column({ name: 'capacity_qty', type: 'int', default: 100 })
  capacityQty!: number;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}
