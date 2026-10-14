-- 0021_add_vehicle_maintenance_tracking.sql
-- Adds mileage/maintenance tracking on top of the ALREADY-EXISTING fleet.vehicles
-- table (created by the team's shared migration pipeline ahead of this app slice,
-- same situation as core.sla_configurations before it — see sla-configuration
-- entity.ts). This migration only ADDS to what's there (AGENTS.md §3: additive
-- only), for story BM-US-09 (Log Vehicle Mileage and Maintenance).
--
-- Design: fleet.vehicles and fleet.riders are separate entities (a vehicle has
-- an optional assigned_rider_id). Mileage/PMS tracking belongs on the vehicle.
-- The "excluded from dispatch" requirement (BM-045) is satisfied by reusing the
-- rider.status = 'Maintenance Due' value that already existed in fleet.riders —
-- its own doc comment says this was previously "set out-of-band (manual seeding
-- for now)"; this slice is what makes it automatic. No new dispatch-query changes
-- needed: the existing 'Available'-only filter already excludes it.
-- Apply via the Supabase SQL editor.

-- Branch-configured PMS interval (AC: "compares new mileage against the
-- branch-configured maintenance_threshold"). Defaults to 3000km; a Branch Owner/
-- FA can tune it per branch later — no config UI in this slice, DB default only.
ALTER TABLE core.branches
  ADD COLUMN IF NOT EXISTS maintenance_threshold_km integer NOT NULL DEFAULT 3000;

-- Running odometer state used to compute "km since last PMS" without scanning
-- the log history on every read.
ALTER TABLE fleet.vehicles
  ADD COLUMN IF NOT EXISTS current_odometer_km integer NOT NULL DEFAULT 0;

ALTER TABLE fleet.vehicles
  ADD COLUMN IF NOT EXISTS last_pms_odometer_km integer NOT NULL DEFAULT 0;

-- Append-only mileage/fuel log — one row per BM entry (AC: "Log entry records
-- Branch Manager identity, vehicle plate, and timestamp"; vehicle plate is read
-- via vehicle_id, not denormalized here, matching the no-FK/service-layer-integrity
-- convention (AGENTS.md §6)).
CREATE TABLE IF NOT EXISTS fleet.vehicle_maintenance_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id    uuid        NOT NULL,
  branch_id     uuid        NOT NULL,
  odometer_km   integer     NOT NULL,
  fuel_liters   numeric,
  logged_by     uuid        NOT NULL,
  logged_at     timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vehicle_maintenance_logs_vehicle_id_idx
  ON fleet.vehicle_maintenance_logs (vehicle_id);

CREATE INDEX IF NOT EXISTS vehicle_maintenance_logs_branch_id_idx
  ON fleet.vehicle_maintenance_logs (branch_id);
