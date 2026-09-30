import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ schema: 'inventory', name: 'stock_check_logs' })
export class StockCheckLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'branch_id', type: 'uuid' })
  branchId!: string;

  @Column({ name: 'checked_by', type: 'uuid' })
  checkedBy!: string;

  @Column({ name: 'checked_at', type: 'timestamptz' })
  checkedAt!: Date;
}
