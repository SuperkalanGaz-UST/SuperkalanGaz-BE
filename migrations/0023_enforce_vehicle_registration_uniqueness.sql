-- 0023_enforce_vehicle_registration_uniqueness.sql
-- Registration is scoped to one branch. These indexes make the service's
-- duplicate checks race-safe without adding foreign-key constraints.

CREATE UNIQUE INDEX IF NOT EXISTS vehicles_branch_plate_number_uq
  ON fleet.vehicles (branch_id, UPPER(plate_number));

CREATE UNIQUE INDEX IF NOT EXISTS vehicles_assigned_rider_uq
  ON fleet.vehicles (assigned_rider_id)
  WHERE assigned_rider_id IS NOT NULL;
