import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Maps core.known_store_locations — a franchise-GLOBAL reference dataset of
 * Superkalan's known store locations, captured once as a snapshot (never a live
 * feed from superkalan.com). It feeds the branch-registration combobox so a
 * Franchise Admin can autofill address + province when provisioning a branch.
 *
 * This is reference data, NOT tenant data: it has NO branch_id and is never
 * placed behind branch-scoping guards (AGENTS.md §5 applies to tenant rows).
 * It lives in the `core` schema alongside branches/users per the 7-schema design
 * (AGENTS.md §6) — `public` is reserved for the Supabase auth-mirror table.
 *
 * Soft delete is modelled here as an is_active flag rather than deleted_at:
 * a retired location is flipped inactive and simply stops appearing in lookups
 * (AGENTS.md §3.2 — this API never hard-deletes).
 */
@Entity({ schema: 'core', name: 'known_store_locations' })
export class KnownStoreLocation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text' })
  name!: string;

  /**
   * Freeform captured address. This is the natural upsert key for the seeder
   * (it is effectively unique across the snapshot), so a lookup index sits on
   * it in the migration.
   */
  @Column({ name: 'full_address', type: 'text' })
  fullAddress!: string;

  /**
   * INFERRED from the freeform address text, not authoritative — one snapshot
   * row is genuinely ambiguous, hence nullable. The UI treats it as an editable
   * default, never a locked value.
   */
  @Column({ type: 'text', nullable: true })
  province!: string | null;

  /**
   * Null for every seed row and NOT reliably derivable from the address string.
   * Kept on the entity for future enrichment, but the registration flow leaves
   * City/Municipality blank-but-editable on autofill rather than fabricating it.
   */
  @Column({ type: 'text', nullable: true })
  city!: string | null;

  /** Soft-delete flag: only is_active = true rows are ever served (AGENTS.md §3.2). */
  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
