import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** A reusable delivery address owned by one authenticated mobile customer. */
@Entity({ schema: 'cim', name: 'customer_addresses' })
export class CustomerAddress {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Logical reference to auth.users.id. No database FK by project convention. */
  @Column({ name: 'auth_user_id', type: 'uuid' })
  authUserId!: string;

  @Column({ type: 'text' })
  label!: string;

  @Column({ name: 'full_address', type: 'text' })
  fullAddress!: string;

  @Column({ type: 'text' })
  province!: string;

  @Column({ type: 'text' })
  city!: string;

  @Column({ type: 'text' })
  barangay!: string;

  @Column({ type: 'text' })
  street!: string;

  @Column({ type: 'text', nullable: true })
  landmark!: string | null;

  @Column({ name: 'contact_number', type: 'text' })
  contactNumber!: string;

  @Column({ type: 'double precision', nullable: true })
  latitude!: number | null;

  @Column({ type: 'double precision', nullable: true })
  longitude!: number | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}
