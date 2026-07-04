import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Maps public.profiles — one row per Supabase auth user, carrying the CRM
 * claims (role + branch scope). Rows are created by the on_auth_user_created
 * trigger when a user is provisioned through the Auth Admin API; this API
 * reads/updates them and NEVER hard-deletes (AGENTS.md §3.2 — soft delete only).
 */
@Entity({ schema: 'public', name: 'profiles' })
export class Profile {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'text', nullable: true })
  email!: string | null;

  @Column({ type: 'text', nullable: true })
  username!: string | null;

  @Column({ name: 'display_name', type: 'text', nullable: true })
  displayName!: string | null;

  @Column({ type: 'text' })
  role!: string;

  /** Branch names this user belongs to. The unit of tenancy scoping (AGENTS.md §5). */
  @Column({ type: 'text', array: true })
  branches!: string[];

  @Column({ type: 'text', nullable: true })
  phone!: string | null;

  @Column({ type: 'text' })
  status!: 'Active' | 'Inactive';

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}
