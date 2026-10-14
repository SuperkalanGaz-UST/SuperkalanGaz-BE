-- 0028_add_super_admin_governance.sql
-- Adds the Super Administrator approval queue and immutable governance audit
-- history in the approved core schema. Identity stays in auth.users; logical
-- auth-user and branch references are indexed but deliberately have no foreign
-- keys (AGENTS.md §6). The public schema remains empty.

CREATE SCHEMA IF NOT EXISTS core;

CREATE TABLE IF NOT EXISTS core.governance_requests (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type               text        NOT NULL,
  status             text        NOT NULL DEFAULT 'pending',
  title              text        NOT NULL,
  reason             text        NOT NULL,
  risk_level         text        NOT NULL DEFAULT 'medium',
  branch_id          uuid,
  requested_by       uuid        NOT NULL,
  requested_by_name  text        NOT NULL,
  payload            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  submitted_at       timestamptz NOT NULL DEFAULT now(),
  decided_by         uuid,
  decided_by_name    text,
  decision_reason    text,
  decided_at         timestamptz,
  applied_at         timestamptz,
  deleted_at         timestamptz,
  CONSTRAINT governance_requests_type_check CHECK (
    type IN (
      'franchise-admin-account',
      'price-configuration',
      'sla-threshold',
      'branch-owner-change',
      'branch-account',
      'other'
    )
  ),
  CONSTRAINT governance_requests_status_check CHECK (
    status IN ('pending', 'applying', 'approved', 'rejected', 'revision-requested')
  ),
  CONSTRAINT governance_requests_risk_check CHECK (
    risk_level IN ('low', 'medium', 'high')
  )
);

CREATE INDEX IF NOT EXISTS governance_requests_type_idx
  ON core.governance_requests (type);
CREATE INDEX IF NOT EXISTS governance_requests_status_idx
  ON core.governance_requests (status);
CREATE INDEX IF NOT EXISTS governance_requests_requested_by_idx
  ON core.governance_requests (requested_by);
CREATE INDEX IF NOT EXISTS governance_requests_branch_id_idx
  ON core.governance_requests (branch_id);
CREATE INDEX IF NOT EXISTS governance_requests_submitted_at_idx
  ON core.governance_requests (submitted_at DESC);
CREATE INDEX IF NOT EXISTS governance_requests_deleted_at_idx
  ON core.governance_requests (deleted_at);

CREATE TABLE IF NOT EXISTS core.governance_audit_events (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category               text        NOT NULL,
  action                 text        NOT NULL,
  actor_user_id          uuid        NOT NULL,
  actor_name             text        NOT NULL,
  actor_role             text        NOT NULL,
  affected_record_type   text        NOT NULL,
  affected_record_id     uuid,
  branch_id              uuid,
  governance_request_id  uuid,
  before_state           jsonb,
  after_state            jsonb,
  reason                 text,
  occurred_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at             timestamptz,
  CONSTRAINT governance_audit_category_check CHECK (
    category IN (
      'approval',
      'admin-account',
      'price-change',
      'branch-owner-change',
      'sla-configuration',
      'security'
    )
  ),
  CONSTRAINT governance_audit_actor_role_check CHECK (
    actor_role IN ('super-admin', 'franchise-admin', 'system')
  )
);

CREATE INDEX IF NOT EXISTS governance_audit_category_idx
  ON core.governance_audit_events (category);
CREATE INDEX IF NOT EXISTS governance_audit_actor_user_id_idx
  ON core.governance_audit_events (actor_user_id);
CREATE INDEX IF NOT EXISTS governance_audit_affected_record_id_idx
  ON core.governance_audit_events (affected_record_id);
CREATE INDEX IF NOT EXISTS governance_audit_branch_id_idx
  ON core.governance_audit_events (branch_id);
CREATE INDEX IF NOT EXISTS governance_audit_request_id_idx
  ON core.governance_audit_events (governance_request_id);
CREATE INDEX IF NOT EXISTS governance_audit_occurred_at_idx
  ON core.governance_audit_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS governance_audit_deleted_at_idx
  ON core.governance_audit_events (deleted_at);

-- Audit rows are append-only even for database roles with direct table write
-- access. Corrections are represented by a new event, never mutation or delete.
CREATE OR REPLACE FUNCTION core.reject_governance_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'governance audit events are immutable';
END;
$$;

DROP TRIGGER IF EXISTS governance_audit_events_immutable
  ON core.governance_audit_events;
CREATE TRIGGER governance_audit_events_immutable
BEFORE UPDATE OR DELETE ON core.governance_audit_events
FOR EACH ROW EXECUTE FUNCTION core.reject_governance_audit_mutation();

-- Super Administrator notifications are role-addressed like other staff
-- notifications. Recreate the constraint without exposing any table publicly.
ALTER TABLE core.notifications
  DROP CONSTRAINT IF EXISTS notifications_audience_role_check;
ALTER TABLE core.notifications
  ADD CONSTRAINT notifications_audience_role_check CHECK (
    audience_role IS NULL OR audience_role IN (
      'super-admin', 'franchise-admin', 'branch-owner', 'branch-manager'
    )
  );
