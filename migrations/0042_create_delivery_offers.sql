CREATE TABLE IF NOT EXISTS srd.delivery_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL,
  service_request_id uuid NOT NULL,
  rider_id uuid NOT NULL,
  previous_rider_id uuid,
  offered_by uuid NOT NULL,
  offered_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'accepted', 'declined', 'expired')),
  responded_at timestamptz,
  vehicle_id uuid,
  vehicle_match text CHECK (vehicle_match IN ('gps', 'confirmed'))
);
CREATE INDEX IF NOT EXISTS delivery_offers_branch_idx ON srd.delivery_offers (branch_id);
CREATE INDEX IF NOT EXISTS delivery_offers_request_idx ON srd.delivery_offers (service_request_id);
CREATE INDEX IF NOT EXISTS delivery_offers_rider_idx ON srd.delivery_offers (rider_id);
CREATE INDEX IF NOT EXISTS delivery_offers_previous_rider_idx ON srd.delivery_offers (previous_rider_id);
CREATE INDEX IF NOT EXISTS delivery_offers_actor_idx ON srd.delivery_offers (offered_by);
CREATE INDEX IF NOT EXISTS delivery_offers_vehicle_idx ON srd.delivery_offers (vehicle_id);
CREATE UNIQUE INDEX IF NOT EXISTS delivery_offers_open_request_uq
  ON srd.delivery_offers (branch_id, service_request_id) WHERE status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS delivery_offers_open_rider_uq
  ON srd.delivery_offers (branch_id, rider_id) WHERE status = 'pending';

-- Keep motorcycles attached to deliveries already in progress during rollout.
WITH released AS (
  UPDATE fleet.vehicles AS vehicle
  SET assigned_rider_id = NULL, updated_at = now()
  WHERE assigned_rider_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM srd.service_requests AS request
      WHERE request.branch_id = vehicle.branch_id
        AND request.rider_id = vehicle.assigned_rider_id
        AND request.dispatched_at IS NOT NULL
        AND request.delivered_at IS NULL
        AND request.deleted_at IS NULL
        AND request.status IN ('Dispatched', 'En Route', 'Under Review')
    )
  RETURNING vehicle.id
)
UPDATE fleet.riders AS rider
SET plate = '', status = CASE WHEN rider.status = 'Maintenance Due' THEN 'Offline' ELSE rider.status END, updated_at = now()
FROM fleet.vehicles AS previous
JOIN released ON released.id = previous.id
WHERE previous.assigned_rider_id = rider.id AND previous.branch_id = rider.branch_id
  AND rider.deleted_at IS NULL;
