import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** Geofence config as stored: shape depends on the mode chosen in the wizard. */
export type Geofence =
  | { mode: 'polygon'; points: [number, number][]; areaKm2?: number }
  | { mode: 'radius'; center: [number, number] | null; radiusKm: number }
  | {
      mode: 'barangays';
      region?: string;
      city?: string;
      district?: string;
      barangays: string[];
    };

/**
 * Maps public.branches — one row per registered franchise branch. Created by
 * the Franchise Admin registration flow. Soft delete only (AGENTS.md §3.2):
 * this API never hard-deletes; deleted_at marks a row retired.
 */
@Entity({ schema: 'public', name: 'branches' })
export class Branch {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ name: 'contact_number', type: 'text', nullable: true })
  contactNumber!: string | null;

  @Column({ type: 'text' })
  address!: string;

  @Column({ type: 'text' })
  city!: string;

  @Column({ type: 'text' })
  province!: string;

  @Column({ name: 'low_stock_threshold', type: 'int', default: 20 })
  lowStockThreshold!: number;

  @Column({ name: 'owner_type', type: 'text', nullable: true })
  ownerType!: string | null;

  @Column({ name: 'owner_name', type: 'text', nullable: true })
  ownerName!: string | null;

  @Column({ name: 'owner_email', type: 'text', nullable: true })
  ownerEmail!: string | null;

  /** profiles/auth id of a freshly-provisioned owner; null for existing owners. */
  @Column({ name: 'owner_id', type: 'uuid', nullable: true })
  ownerId!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  geofence!: Geofence | null;

  @Column({ name: 'curfew_start', type: 'text', nullable: true })
  curfewStart!: string | null;

  @Column({ name: 'curfew_end', type: 'text', nullable: true })
  curfewEnd!: string | null;

  @Column({ type: 'text', default: 'Active' })
  status!: 'Active' | 'Inactive';

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}
