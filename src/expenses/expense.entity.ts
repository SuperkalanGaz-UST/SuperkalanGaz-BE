import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { ExpenseCategory } from './expense-category';

const decimalTransformer = {
  to: (value: number) => value,
  from: (value: string) => Number(value),
};

/**
 * Maps core.operational_expenses. branch_id and recorded_by are always derived
 * from the verified principal in ExpensesService, never from request input.
 * Rows are soft-deleted through deleted_at; this module exposes no delete path.
 */
@Entity({ schema: 'core', name: 'operational_expenses' })
export class Expense {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'branch_id', type: 'uuid' })
  branchId!: string;

  /** PostgreSQL date is kept as YYYY-MM-DD so no timezone conversion can move it across months. */
  @Column({ name: 'expense_date', type: 'date' })
  expenseDate!: string;

  @Column({ name: 'reference_no', type: 'text', nullable: true })
  referenceNo!: string | null;

  @Column({ type: 'text' })
  category!: ExpenseCategory;

  @Column({ type: 'text' })
  description!: string;

  @Column({ type: 'numeric', precision: 12, scale: 2, transformer: decimalTransformer })
  amount!: number;

  /** Filename metadata only; the web UI does not claim a downloadable document exists. */
  @Column({ name: 'receipt_name', type: 'text', nullable: true })
  receiptName!: string | null;

  @Column({ name: 'recorded_by', type: 'uuid' })
  recordedBy!: string;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}
