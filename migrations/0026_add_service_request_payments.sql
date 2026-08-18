-- 0026_add_service_request_payments.sql
-- Adds the CU-017 payment state to the existing SRD Service Request record.
-- Keeping the one-to-one state on srd.service_requests preserves the confirmed
-- schema inventory while still retaining the provider identifiers needed to
-- verify and de-duplicate PayMongo callbacks. No database foreign keys are
-- introduced; branch/customer integrity remains enforced by NestJS.

ALTER TABLE srd.service_requests
  ADD COLUMN IF NOT EXISTS payment_method text NOT NULL DEFAULT 'Cash on Delivery',
  ADD COLUMN IF NOT EXISTS payment_status text NOT NULL DEFAULT 'Unpaid',
  ADD COLUMN IF NOT EXISTS paymongo_checkout_session_id text,
  ADD COLUMN IF NOT EXISTS paymongo_checkout_url text,
  ADD COLUMN IF NOT EXISTS paymongo_reference text,
  ADD COLUMN IF NOT EXISTS paymongo_payment_id text,
  ADD COLUMN IF NOT EXISTS paymongo_webhook_event_id text,
  ADD COLUMN IF NOT EXISTS payment_paid_at timestamptz;

-- A delivered legacy order necessarily completed the Cash on Delivery flow.
-- Backfill that fact so historical rows do not appear as collectible balances
-- after this migration is applied.
UPDATE srd.service_requests
SET payment_status = 'Paid',
    payment_paid_at = delivered_at
WHERE status = 'Delivered'
  AND payment_method = 'Cash on Delivery'
  AND payment_status = 'Unpaid';

-- Payment reporting is always branch-scoped. Provider identifiers are unique
-- lookup handles and stay nullable for Cash on Delivery Service Requests.
CREATE INDEX IF NOT EXISTS service_requests_branch_payment_status_idx
  ON srd.service_requests (branch_id, payment_status)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS service_requests_paymongo_checkout_session_uq
  ON srd.service_requests (paymongo_checkout_session_id)
  WHERE paymongo_checkout_session_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS service_requests_paymongo_reference_uq
  ON srd.service_requests (paymongo_reference)
  WHERE paymongo_reference IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS service_requests_paymongo_payment_uq
  ON srd.service_requests (paymongo_payment_id)
  WHERE paymongo_payment_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS service_requests_paymongo_webhook_event_uq
  ON srd.service_requests (paymongo_webhook_event_id)
  WHERE paymongo_webhook_event_id IS NOT NULL;
