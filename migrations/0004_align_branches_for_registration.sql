-- 0004_align_branches_for_registration.sql
-- Aligns the live core.branches table with the branch-registration flow.
--
-- Adds the two location fields the wizard collects (province is an editable
-- default that may originate from a known_store_locations autofill; city is
-- left blank-but-editable). Both nullable, following the reference data.
--
-- Adds a unique index on `code` among live (status='active') rows: `code` is the
-- branch's stable identifier, auto-generated at registration. Uniqueness is NOT
-- placed on `name` on purpose — two genuinely different stores can share a name
-- (e.g. the two "LAGUNA PREMIUM GAS" locations), so names are non-unique by
-- design; duplicate provisioning is prevented via source_store_location_id, not
-- the name. Soft delete is status-based (AGENTS.md §3.2): an 'inactive' branch
-- may free its code for reuse. Apply via the Supabase SQL editor.

ALTER TABLE core.branches
  ADD COLUMN IF NOT EXISTS province text,
  ADD COLUMN IF NOT EXISTS city     text;

-- Backstops the service-layer code-uniqueness check against races (AGENTS.md §6:
-- integrity is enforced in the service layer, but a unique index is a cheap,
-- defensible guard here since `code` is an identifier).
CREATE UNIQUE INDEX IF NOT EXISTS branches_code_active_uq
  ON core.branches (code)
  WHERE status = 'active';

-- The registry list orders/filters by name and status.
CREATE INDEX IF NOT EXISTS branches_name_idx   ON core.branches (name);
CREATE INDEX IF NOT EXISTS branches_status_idx ON core.branches (status);
