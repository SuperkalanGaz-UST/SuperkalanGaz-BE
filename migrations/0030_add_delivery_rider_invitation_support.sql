-- Links invitation-provisioned Delivery Riders to their retained Supabase Auth
-- identity. The reference is indexed but intentionally has no FK constraint.
ALTER TABLE fleet.riders
  ADD COLUMN IF NOT EXISTS auth_user_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS riders_auth_user_id_live_uq
  ON fleet.riders (auth_user_id)
  WHERE auth_user_id IS NOT NULL AND deleted_at IS NULL;

-- Preserve the real authorizing/accepting persona in the immutable audit stream.
ALTER TABLE core.governance_audit_events
  DROP CONSTRAINT IF EXISTS governance_audit_actor_role_check;

ALTER TABLE core.governance_audit_events
  ADD CONSTRAINT governance_audit_actor_role_check CHECK (
    actor_role IN (
      'super-admin',
      'franchise-admin',
      'branch-owner',
      'driver',
      'system'
    )
  );
