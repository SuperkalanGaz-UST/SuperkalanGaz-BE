-- 0001_create_branches.sql
-- Creates core.branches — one row per franchise branch registered through the
-- Franchise Admin "Register new branch account" flow. Lives in the `core` schema
-- (AGENTS.md §6): the `public` schema is deliberately kept empty so nothing is
-- reachable through Supabase's auto-exposed PostgREST anon path. Text columns,
-- timestamptz audit fields, soft delete only (AGENTS.md §3.2, §6). Apply via the
-- Supabase SQL editor.

CREATE SCHEMA IF NOT EXISTS core;

CREATE TABLE IF NOT EXISTS core.branches (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 text        NOT NULL,
  contact_number       text,
  address              text        NOT NULL,
  city                 text        NOT NULL,
  province             text        NOT NULL,
  low_stock_threshold  integer     NOT NULL DEFAULT 20,
  -- Owner assignment is captured descriptively at registration time. Provisioning
  -- an actual auth user is the Users module's job, so only display info is stored.
  owner_type           text,
  owner_name           text,
  owner_email          text,
  -- Set when a brand-new owner is provisioned: the auth.users id of the created
  -- Branch Owner (identity lives in Supabase Auth, not a profiles table). NULL
  -- for the "existing owner" path. No FK by
  -- design (AGENTS.md §6 — integrity is enforced in the service layer).
  owner_id             uuid,
  -- Geofence + curfew are stored as a single JSON blob: shape varies by mode
  -- (polygon / radius / barangays) and is read back as-is by the dashboard.
  geofence             jsonb,
  curfew_start         text,
  curfew_end           text,
  status               text        NOT NULL DEFAULT 'Active',
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz
);

-- Branch names are unique among live rows; a soft-deleted name can be reused.
CREATE UNIQUE INDEX IF NOT EXISTS branches_name_active_uq
  ON core.branches (name)
  WHERE deleted_at IS NULL;

-- Soft-delete filter runs on every list/lookup (AGENTS.md §6: index lookup cols).
CREATE INDEX IF NOT EXISTS branches_deleted_at_idx
  ON core.branches (deleted_at);
