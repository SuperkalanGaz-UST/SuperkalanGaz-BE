-- 0007_create_service_requests.sql
-- Creates srd.service_requests — one row per LPG delivery order (a "Service
-- Request" in ITIL 4 terms, AGENTS.md §9). This is the foundation of the SRD
-- module: staff-initiated (walk-in/phone) and, later, mobile-app intake.
-- Follows project conventions (AGENTS.md §6): UUID PK, no FK constraints
-- (integrity is enforced in the NestJS service layer), timestamptz audit fields,
-- soft delete only (§3.2), and an explicit index on every lookup column.
-- Apply via the Supabase SQL editor.

-- SRD lives in its own schema (AGENTS.md §6). Create it first so the table below
-- has somewhere to land; IF NOT EXISTS keeps the migration idempotent.
CREATE SCHEMA IF NOT EXISTS srd;

CREATE TABLE IF NOT EXISTS srd.service_requests (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Tenancy handle. Server-derived from the verified principal at creation
  -- time; never trusted from the client. No FK by design (§6) — the service
  -- layer validates the branch exists and belongs to the caller.
  branch_id             uuid        NOT NULL,
  -- Channel this order came through, for channel-level SLA reporting
  -- (AGENTS.md §8.2 — mandatory on every request). 'Mobile App' | 'Walk-in/Phone'.
  order_source          text        NOT NULL,
  -- Lifecycle state: 'Pending' | 'Dispatched' | 'En Route' | 'Delivered' | 'Cancelled'.
  status                text        NOT NULL DEFAULT 'Pending',
  -- Customer details are denormalized onto the order for now: the CIM module
  -- (customer profiles) is not built yet, so intake captures them inline.
  customer_name         text        NOT NULL,
  customer_contact      text        NOT NULL,
  delivery_address      text        NOT NULL,
  -- Plain string for MVP (e.g. "11kg"). A products/pricing catalog is a
  -- deferred decision (AGENTS.md §13) — do not model it here yet.
  cylinder_size         text        NOT NULL,
  quantity              integer     NOT NULL,
  special_instructions  text,
  -- Four-timestamp SLA chain (AGENTS.md §8.2). requested_at is set on create;
  -- the remaining three are populated by later slices (dispatch / in-transit /
  -- delivery) and stay NULL until then.
  requested_at          timestamptz NOT NULL DEFAULT now(),
  dispatched_at         timestamptz,
  in_transit_at         timestamptz,
  delivered_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz
);

-- Every list/lookup filters by branch (tenancy scope) and excludes soft-deleted
-- rows, and reporting slices by status / channel. Index each lookup column
-- (AGENTS.md §6) in the same migration that introduces it.
CREATE INDEX IF NOT EXISTS service_requests_branch_id_idx
  ON srd.service_requests (branch_id);

CREATE INDEX IF NOT EXISTS service_requests_status_idx
  ON srd.service_requests (status);

CREATE INDEX IF NOT EXISTS service_requests_order_source_idx
  ON srd.service_requests (order_source);

CREATE INDEX IF NOT EXISTS service_requests_deleted_at_idx
  ON srd.service_requests (deleted_at);
