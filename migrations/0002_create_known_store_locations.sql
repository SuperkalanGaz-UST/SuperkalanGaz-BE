-- 0002_create_known_store_locations.sql
-- Creates core.known_store_locations — a franchise-GLOBAL reference dataset of
-- Superkalan's known store locations, seeded once from a captured snapshot and
-- used to autofill the branch-registration combobox.
--
-- Lives in the `core` schema per the 7-schema design (AGENTS.md §6), alongside
-- core.branches / core.users. This is reference data, NOT tenant data: it has NO
-- branch_id and is never branch-scoped (AGENTS.md §5). Following project
-- conventions: no foreign-key constraints (integrity enforced in the service
-- layer, AGENTS.md §6), soft delete only via is_active (AGENTS.md §3.2), UUID
-- primary key. Apply via the Supabase SQL editor.

CREATE TABLE IF NOT EXISTS core.known_store_locations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text        NOT NULL,
  -- Natural upsert key for the idempotent seeder; effectively unique across the
  -- snapshot. Not enforced UNIQUE because the raw capture contains one exact
  -- duplicate the seeder collapses in application code, not the DB.
  full_address  text        NOT NULL,
  -- Province is INFERRED from freeform address text, not authoritative, and one
  -- row is genuinely ambiguous — hence nullable.
  province      text,
  -- Null for every seed row and not reliably derivable; kept for future use.
  city          text,
  -- Soft-delete flag: only is_active = true rows are served (AGENTS.md §3.2).
  is_active     boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Explicit indexes on every lookup/filter column (AGENTS.md §6). The read
-- endpoint filters case-insensitively on name (ILIKE) and exact-matches on
-- province; the seeder looks rows up by full_address.
CREATE INDEX IF NOT EXISTS known_store_locations_name_idx
  ON core.known_store_locations (name);

CREATE INDEX IF NOT EXISTS known_store_locations_province_idx
  ON core.known_store_locations (province);

CREATE INDEX IF NOT EXISTS known_store_locations_full_address_idx
  ON core.known_store_locations (full_address);
