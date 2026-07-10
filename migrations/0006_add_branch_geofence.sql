-- 0006_add_branch_geofence.sql
-- Adds delivery-coverage storage to core.branches. The Franchise Registry "Edit"
-- modal now persists a drawn polygon here; previously the wizard collected a
-- geofence but it was dropped (deferred). Stored as jsonb of the shape
-- { "type": "polygon", "points": [[lat, lng], ...] }; NULL means no coverage set.
-- Apply via the Supabase SQL editor.

ALTER TABLE core.branches
  ADD COLUMN IF NOT EXISTS geofence jsonb;
