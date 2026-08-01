import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { Role } from '../auth/principal';

export type NotificationType =
  | 'price-update'
  | 'customer-complaint'
  | 'branch-approval'
  | 'service-request'
  | 'loyalty-redemption'
  | 'inventory-alert'
  | 'system';

/**
 * Cross-cutting staff notification stored in core.notifications. This is not a
 * sixth CRM business module: it only surfaces events produced by the confirmed
 * domains. Price updates are global; every other event declares a target role
 * and can optionally be scoped to one branch.
 */
@Entity({ schema: 'core', name: 'notifications' })
export class StaffNotification {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text' })
  type!: NotificationType;

  @Column({ name: 'audience_role', type: 'text', nullable: true })
  audienceRole!: Role | null;

  @Column({ name: 'branch_id', type: 'uuid', nullable: true })
  branchId!: string | null;

  @Column({ type: 'text' })
  title!: string;

  @Column({ type: 'text' })
  message!: string;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}
