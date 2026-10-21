-- Request-bound Traccar mileage cache. No route accepts a vehicle/device/branch
-- mapping from the client. Each row is created from an authorized fleet vehicle.
-- No FKs by workspace convention; reference columns are indexed here.
CREATE TABLE IF NOT EXISTS fleet.vehicle_gps_mileage (
  vehicle_id uuid PRIMARY KEY,
  branch_id uuid NOT NULL,
  device_id bigint NOT NULL,
  total_distance_m double precision,
  remainder_m double precision NOT NULL DEFAULT 0,
  position_at timestamptz,
  baseline_after timestamptz NOT NULL DEFAULT now(),
  synced_at timestamptz,
  next_poll_at timestamptz NOT NULL DEFAULT now(),
  failures integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'waiting',
  CONSTRAINT vehicle_gps_mileage_distance_check CHECK (
    (total_distance_m IS NULL OR (total_distance_m >= 0 AND total_distance_m < 1e12))
    AND remainder_m >= 0 AND remainder_m < 1000
  ),
  CONSTRAINT vehicle_gps_mileage_status_check CHECK (
    status IN ('waiting', 'synced', 'unavailable', 'counter-reset')
  )
);
CREATE INDEX IF NOT EXISTS vehicle_gps_mileage_branch_idx
  ON fleet.vehicle_gps_mileage (branch_id);
CREATE INDEX IF NOT EXISTS vehicle_gps_mileage_device_idx
  ON fleet.vehicle_gps_mileage (device_id);
