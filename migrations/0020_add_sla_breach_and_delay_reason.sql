-- 0020_add_sla_breach_and_delay_reason.sql
-- Extends srd.service_requests for the delayed-delivery journey (BM-US-02,
-- stories BM-008..012).
--
-- delay_reason: the Branch Manager's logged reason for a delay (BM-011,
-- "dropdown + optional free-text"), stored as one combined display string.
--
-- sla_breached / sla_breach_segment / sla_breached_at: the PERSISTED breach
-- record (BM-012). Computed once, at delivery, from the four real SLA
-- timestamps against core.sla_configurations — and, being computed from
-- timestamps that a rider reassignment never touches (see the service-layer
-- interpretation note), this record survives reassignment untouched
-- ("the original SLA breach is not erased").
--
-- ADDITIVE and non-breaking: all four columns are nullable or defaulted, so
-- every existing service_requests row is unaffected (delay_reason stays NULL,
-- sla_breached defaults to false). Apply via the Supabase SQL editor.

ALTER TABLE srd.service_requests
  ADD COLUMN IF NOT EXISTS delay_reason text,
  ADD COLUMN IF NOT EXISTS sla_breached boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sla_breach_segment text,
  ADD COLUMN IF NOT EXISTS sla_breached_at timestamptz;

-- FA/BO-level SLA reporting filters by branch + breach status (AGENTS.md §6).
CREATE INDEX IF NOT EXISTS service_requests_sla_breached_idx
  ON srd.service_requests (branch_id, sla_breached)
  WHERE sla_breached = true;
