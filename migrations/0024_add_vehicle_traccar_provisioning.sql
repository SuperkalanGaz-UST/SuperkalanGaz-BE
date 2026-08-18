-- 0024_add_vehicle_traccar_provisioning.sql
-- Keeps the CRM vehicle UUID, the physical SinoTrack identifier, and Traccar's
-- middleware identifier distinct. Existing vehicles remain "unconfigured";
-- newly registered vehicles move through pending -> provisioned/failed in the
-- NestJS service. No database foreign keys are added by design.

ALTER TABLE fleet.vehicles
  ADD COLUMN IF NOT EXISTS hardware_unique_id text;

ALTER TABLE fleet.vehicles
  ADD COLUMN IF NOT EXISTS traccar_device_id bigint;

ALTER TABLE fleet.vehicles
  ADD COLUMN IF NOT EXISTS traccar_provisioning_status text NOT NULL DEFAULT 'unconfigured';

ALTER TABLE fleet.vehicles
  ADD COLUMN IF NOT EXISTS traccar_provisioning_error text;

ALTER TABLE fleet.vehicles
  ADD COLUMN IF NOT EXISTS traccar_provisioned_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'vehicles_traccar_provisioning_status_check'
      AND conrelid = 'fleet.vehicles'::regclass
  ) THEN
    ALTER TABLE fleet.vehicles
      ADD CONSTRAINT vehicles_traccar_provisioning_status_check
      CHECK (traccar_provisioning_status IN ('unconfigured', 'pending', 'provisioned', 'failed'));
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS vehicles_hardware_unique_id_uq
  ON fleet.vehicles (hardware_unique_id)
  WHERE hardware_unique_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS vehicles_traccar_device_id_uq
  ON fleet.vehicles (traccar_device_id)
  WHERE traccar_device_id IS NOT NULL;
