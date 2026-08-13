import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** Per-user read state. The user id is the verified Supabase auth subject. */
@Entity({ schema: 'core', name: 'notification_receipts' })
export class NotificationReceipt {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'notification_id', type: 'uuid' })
  notificationId!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ name: 'read_at', type: 'timestamptz' })
  readAt!: Date;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
