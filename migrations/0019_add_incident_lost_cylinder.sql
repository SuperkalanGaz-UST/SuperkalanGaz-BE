-- 0019_add_incident_lost_cylinder.sql
-- Extends csat.incidents for the lost/undelivered cylinder complaint journey
-- (BM-US-04, stories BM-019..BM-022).
--
-- 1. Widens the category CHECK to add 'lost_cylinder' — the existing values
--    (late_delivery, wrong_item, safety, billing, other) have no on-topic fit for
--    this journey's subject matter. ADDITIVE: existing rows/values are untouched,
--    'other' remains available as a catch-all.
--
-- 2. Adds the escalation flag + timestamp story BM-022 requires ("flag that this
--    incident has been escalated outside the system... the system records the
--    flag only — no external API calls or automated messages are sent"). Separate
--    from `status` (open/in_progress/resolved/closed) because escalation is an
--    orthogonal fact, not a lifecycle state: an incident can be escalated while
--    still open, and escalating never itself closes it.
--
-- ADDITIVE and non-breaking: escalated defaults to false, so every existing row
-- starts un-escalated with no backfill required. Apply via the Supabase SQL editor.

ALTER TABLE csat.incidents
  DROP CONSTRAINT IF EXISTS incidents_category_check;

ALTER TABLE csat.incidents
  ADD CONSTRAINT incidents_category_check
  CHECK (category IN ('late_delivery', 'wrong_item', 'safety', 'billing', 'lost_cylinder', 'other'));

ALTER TABLE csat.incidents
  ADD COLUMN IF NOT EXISTS escalated boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS escalated_at timestamptz;

-- The Branch Manager's incident queue filters by (branch, status), so index the
-- lookup columns it drives (AGENTS.md §6), matching the ratings precedent.
CREATE INDEX IF NOT EXISTS incidents_branch_status_idx
  ON csat.incidents (branch_id, status);

CREATE INDEX IF NOT EXISTS incidents_service_request_id_idx
  ON csat.incidents (service_request_id);
