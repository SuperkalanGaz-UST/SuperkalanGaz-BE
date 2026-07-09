-- 0004_create_fleet_riders.sql
-- Creates fleet.riders — one row per delivery rider (motorcycle courier) that a
-- branch can dispatch a Service Request to. This is the minimal roster backing
-- the BM dispatch dropdown (story BM-003); riders are seeded manually for now,
-- there is no rider-CRUD UI in this slice, and — per AGENTS.md §8/§11 — riders
-- have NO mobile app or client. Live GPS (SinoTrack ST-901 → Traccar) is
-- hardware-dependent and deferred; this table carries no GPS/telematics columns.
-- Follows project conventions (AGENTS.md §6): UUID PK, no FK constraints
-- (integrity is enforced in the NestJS service layer), timestamptz audit fields,
-- soft delete only (§3.2), and an explicit index on every lookup column.
-- Apply via the Supabase SQL editor.

-- Fleet lives in its own schema (AGENTS.md §6). Create it first so the table
-- below has somewhere to land; IF NOT EXISTS keeps the migration idempotent.
CREATE SCHEMA IF NOT EXISTS fleet;

CREATE TABLE IF NOT EXISTS fleet.riders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Tenancy handle. A rider belongs to exactly one branch; dispatch only ever
  -- assigns a rider to a Service Request in the SAME branch. Server-derived from
  -- the verified principal at read time; never trusted from the client. No FK by
  -- design (§6) — the service layer validates the branch/rider relationship.
  branch_id   uuid        NOT NULL,
  name        text        NOT NULL,
  -- Motorcycle plate, shown next to the rider name in the dispatch dropdown.
  plate       text        NOT NULL,
  -- Availability state driving the dispatch dropdown:
  -- 'Available' | 'On Delivery' | 'Maintenance Due' | 'Offline'.
  -- A rider flips to 'On Delivery' on dispatch and back to 'Available' when the
  -- order is marked delivered (Slice 3). Only 'Available' riders are assignable.
  status      text        NOT NULL DEFAULT 'Available',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);

-- Every list/lookup filters by branch (tenancy scope) and excludes soft-deleted
-- rows; the dispatch dropdown filters by status ('Available'). Index each lookup
-- column (AGENTS.md §6) in the same migration that introduces it.
CREATE INDEX IF NOT EXISTS riders_branch_id_idx
  ON fleet.riders (branch_id);

CREATE INDEX IF NOT EXISTS riders_status_idx
  ON fleet.riders (status);

CREATE INDEX IF NOT EXISTS riders_deleted_at_idx
  ON fleet.riders (deleted_at);
