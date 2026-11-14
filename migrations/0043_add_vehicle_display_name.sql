-- 0043_add_vehicle_display_name.sql
-- Optional, Branch Manager-entered label for a branch vehicle (for example
-- "Red Yamaha Single Tank"). The plate number remains the authoritative
-- identifier for uniqueness, dispatch confirmation, and Traccar provisioning;
-- this column is display-only, so it is not indexed or unique.

ALTER TABLE fleet.vehicles
  ADD COLUMN IF NOT EXISTS display_name text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'vehicles_display_name_length_check'
      AND conrelid = 'fleet.vehicles'::regclass
  ) THEN
    ALTER TABLE fleet.vehicles
      ADD CONSTRAINT vehicles_display_name_length_check
      CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 60);
  END IF;
END
$$;
