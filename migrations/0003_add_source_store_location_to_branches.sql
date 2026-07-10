-- 0003_add_source_store_location_to_branches.sql
-- Records which core.known_store_locations reference a branch was provisioned
-- from. This provenance column is the SOLE basis for "already registered"
-- duplicate detection in the registration combobox — never branch name or
-- address, both of which are editable and non-unique.
--
-- Targets core.branches (the live 7-schema design, AGENTS.md §6). NULL for
-- branches created from free-text (no reference chosen). No foreign-key
-- constraint by convention (AGENTS.md §6 — integrity is enforced in the service
-- layer); explicit index because the reference endpoint joins/filters on it.
-- Apply via the Supabase SQL editor.

ALTER TABLE core.branches
  ADD COLUMN IF NOT EXISTS source_store_location_id uuid;

CREATE INDEX IF NOT EXISTS branches_source_store_location_id_idx
  ON core.branches (source_store_location_id);
