-- Delivery Rider phone GPS supports Service Request and dispatch operations.
-- It is intentionally stored on fleet.riders separately from authoritative
-- SinoTrack ST-901/Traccar vehicle telemetry used for geofencing and PMS.

ALTER TABLE fleet.riders
  ADD COLUMN operational_latitude DOUBLE PRECISION,
  ADD COLUMN operational_longitude DOUBLE PRECISION,
  ADD COLUMN operational_accuracy_m REAL,
  ADD COLUMN operational_location_captured_at TIMESTAMPTZ,
  ADD COLUMN operational_location_received_at TIMESTAMPTZ,
  ADD CONSTRAINT ck_riders_operational_latitude
    CHECK (operational_latitude IS NULL OR operational_latitude BETWEEN -90 AND 90),
  ADD CONSTRAINT ck_riders_operational_longitude
    CHECK (operational_longitude IS NULL OR operational_longitude BETWEEN -180 AND 180),
  ADD CONSTRAINT ck_riders_operational_accuracy
    CHECK (operational_accuracy_m IS NULL OR operational_accuracy_m BETWEEN 0 AND 10000),
  ADD CONSTRAINT ck_riders_operational_location_complete
    CHECK (
      (operational_latitude IS NULL
        AND operational_longitude IS NULL
        AND operational_location_captured_at IS NULL
        AND operational_location_received_at IS NULL)
      OR
      (operational_latitude IS NOT NULL
        AND operational_longitude IS NOT NULL
        AND operational_location_captured_at IS NOT NULL
        AND operational_location_received_at IS NOT NULL)
    );
