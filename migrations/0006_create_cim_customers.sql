-- 0006_create_cim_customers.sql
-- Creates cim.customers — one row per customer profile a branch has registered
-- (Customer Information Management module, AGENTS.md §8.1 / ITIL 4 Relationship
-- Management §9). This backs the Branch Manager intake flow: search existing
-- customers to autopopulate an order (stories BM-024/BM-025) and register a new
-- customer inline (stories BM-029/BM-030/BM-031).
-- Follows project conventions (AGENTS.md §6): UUID PK, no FK constraints
-- (integrity is enforced in the NestJS service layer), timestamptz audit fields,
-- soft delete only (§3.2), and an explicit index on every lookup column.
-- Apply via the Supabase SQL editor.

-- CIM lives in its own schema (AGENTS.md §6). Create it first so the table below
-- has somewhere to land; IF NOT EXISTS keeps the migration idempotent.
CREATE SCHEMA IF NOT EXISTS cim;

CREATE TABLE IF NOT EXISTS cim.customers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Tenancy handle. A customer belongs to the branch that registered them.
  -- Server-derived from the verified principal at creation time; never trusted
  -- from the client. No FK by design (§6) — the service layer validates scope.
  branch_id           uuid        NOT NULL,
  name                text        NOT NULL,
  contact_number      text        NOT NULL,
  delivery_address    text        NOT NULL,
  -- How this profile was created: 'staff-created' (a Branch Manager registered
  -- them during intake — story BM-031) | 'self-registered' (customer mobile
  -- self-registration). Only 'staff-created' is written by this API today; the
  -- mobile self-registration path is not built (customers are mobile-only and
  -- that client does not exist yet). Text + comment rather than a CHECK, matching
  -- the status/order_source columns elsewhere in this schema.
  registration_source text        NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz
);

-- Every search/lookup filters by branch (tenancy scope) and excludes soft-deleted
-- rows. Index each lookup column (AGENTS.md §6) in the same migration that
-- introduces it.
CREATE INDEX IF NOT EXISTS customers_branch_id_idx
  ON cim.customers (branch_id);

CREATE INDEX IF NOT EXISTS customers_deleted_at_idx
  ON cim.customers (deleted_at);

-- NOTE: name/contact search is ILIKE '%term%' in the service layer. A trigram
-- (pg_trgm GIN) index would accelerate those leading-wildcard scans, but that is
-- a future optimization — the roster is small for MVP, so it is deliberately NOT
-- added now (AGENTS.md §3.5 MVP-first).
