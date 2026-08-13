-- 0013_create_staff_notifications.sql
-- Cross-cutting staff notifications stored in core. These tables do not add a
-- new CRM business module; they surface events from the confirmed domains.
-- Visibility is enforced by the NestJS service from verified JWT role/branch
-- claims. No application data is exposed through public/PostgREST.

CREATE SCHEMA IF NOT EXISTS core;

CREATE TABLE IF NOT EXISTS core.notifications (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type           text        NOT NULL,
  -- NULL is reserved for the global price-update audience. Other event types
  -- carry one explicit staff role.
  audience_role  text,
  -- NULL means global within the audience role. BO/BM branch-owned rows are
  -- filtered against Principal.branchIds in the application layer.
  branch_id      uuid,
  title          text        NOT NULL,
  message        text        NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  CONSTRAINT notifications_type_check CHECK (
    type IN (
      'price-update',
      'customer-complaint',
      'branch-approval',
      'service-request',
      'loyalty-redemption',
      'inventory-alert',
      'system'
    )
  ),
  CONSTRAINT notifications_audience_role_check CHECK (
    audience_role IS NULL OR audience_role IN (
      'franchise-admin', 'branch-owner', 'branch-manager'
    )
  ),
  CONSTRAINT notifications_price_global_check CHECK (
    (type = 'price-update' AND audience_role IS NULL AND branch_id IS NULL)
    OR (type <> 'price-update' AND audience_role IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS notifications_type_idx
  ON core.notifications (type);
CREATE INDEX IF NOT EXISTS notifications_audience_role_idx
  ON core.notifications (audience_role);
CREATE INDEX IF NOT EXISTS notifications_branch_id_idx
  ON core.notifications (branch_id);
CREATE INDEX IF NOT EXISTS notifications_created_at_idx
  ON core.notifications (created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_deleted_at_idx
  ON core.notifications (deleted_at);

CREATE TABLE IF NOT EXISTS core.notification_receipts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id  uuid        NOT NULL,
  -- Supabase auth.users subject. No FK by project convention; the verified JWT
  -- is the source of identity and the service validates notification access.
  user_id           uuid        NOT NULL,
  read_at           timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_receipts_notification_user_unique
    UNIQUE (notification_id, user_id)
);

CREATE INDEX IF NOT EXISTS notification_receipts_notification_id_idx
  ON core.notification_receipts (notification_id);
CREATE INDEX IF NOT EXISTS notification_receipts_user_id_idx
  ON core.notification_receipts (user_id);
