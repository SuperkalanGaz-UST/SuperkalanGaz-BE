-- 0032_add_service_request_codes.sql
-- Adds a stable, human-readable Service Request code. The UUID primary key
-- remains the internal identifier; this code is safe to show in staff and
-- Delivery Rider interfaces without exposing a hashed-looking UUID.

CREATE SEQUENCE IF NOT EXISTS srd.service_request_code_seq START 1;

ALTER TABLE srd.service_requests
  ADD COLUMN IF NOT EXISTS sr_code text;

-- Backfill existing rows deterministically by creation order.
WITH ordered AS (
  SELECT id,
         row_number() OVER (ORDER BY created_at, id) AS rn
  FROM srd.service_requests
  WHERE sr_code IS NULL
)
UPDATE srd.service_requests service_request
SET sr_code = 'SR-' || lpad(ordered.rn::text, 5, '0')
FROM ordered
WHERE service_request.id = ordered.id;

-- Continue after the highest code already present. With no rows, the false
-- third argument makes the first nextval return 1.
SELECT setval(
  'srd.service_request_code_seq',
  COALESCE((
    SELECT MAX(SUBSTRING(sr_code FROM 4)::bigint)
    FROM srd.service_requests
    WHERE sr_code ~ '^SR-[0-9]+$'
  ), 1),
  EXISTS (
    SELECT 1
    FROM srd.service_requests
    WHERE sr_code ~ '^SR-[0-9]+$'
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS service_requests_sr_code_uidx
  ON srd.service_requests (sr_code);

CREATE OR REPLACE FUNCTION srd.assign_service_request_code()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.sr_code IS NULL OR btrim(NEW.sr_code) = '' THEN
    NEW.sr_code := 'SR-' || lpad(nextval('srd.service_request_code_seq')::text, 5, '0');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS service_requests_assign_code ON srd.service_requests;
CREATE TRIGGER service_requests_assign_code
BEFORE INSERT ON srd.service_requests
FOR EACH ROW EXECUTE FUNCTION srd.assign_service_request_code();

ALTER TABLE srd.service_requests
  ALTER COLUMN sr_code SET NOT NULL;
