import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

const decimal = {
  to: (value: number) => value,
  from: (value: string) => Number(value),
};

@Entity({ schema: 'core', name: 'salary_expenses' })
export class SalaryExpense {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'branch_id', type: 'uuid' }) branchId!: string;
  @Column({ name: 'staff_id', type: 'uuid' }) staffId!: string;
  /** Historical display snapshots; role and membership are validated against Auth at creation. */
  @Column({ name: 'staff_name', type: 'text' }) staffName!: string;
  @Column({ name: 'staff_role', type: 'text' }) staffRole!:
    | 'branch-manager'
    | 'driver';
  @Column({ name: 'period_start', type: 'date' }) periodStart!: string;
  @Column({ name: 'period_end', type: 'date' }) periodEnd!: string;
  @Column({
    name: 'regular_hours',
    type: 'numeric',
    precision: 10,
    scale: 2,
    transformer: decimal,
  })
  regularHours!: number;
  @Column({
    name: 'hourly_rate',
    type: 'numeric',
    precision: 12,
    scale: 2,
    transformer: decimal,
  })
  hourlyRate!: number;
  @Column({
    name: 'overtime_hours',
    type: 'numeric',
    precision: 10,
    scale: 2,
    transformer: decimal,
  })
  overtimeHours!: number;
  @Column({
    name: 'overtime_hourly_rate',
    type: 'numeric',
    precision: 12,
    scale: 2,
    transformer: decimal,
  })
  overtimeHourlyRate!: number;
  @Column({
    name: 'regular_pay',
    type: 'numeric',
    precision: 12,
    scale: 2,
    transformer: decimal,
  })
  regularPay!: number;
  @Column({
    name: 'overtime_pay',
    type: 'numeric',
    precision: 12,
    scale: 2,
    transformer: decimal,
  })
  overtimePay!: number;
  @Column({ type: 'numeric', precision: 12, scale: 2, transformer: decimal })
  total!: number;
  @Column({ name: 'request_id', type: 'uuid' }) requestId!: string;
  @Column({ name: 'recorded_by', type: 'uuid' }) recordedBy!: string;
  @Column({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}
