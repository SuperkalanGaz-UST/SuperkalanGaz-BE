-- 0025_sync_mobile_customers_to_cim.sql
-- Materializes authenticated mobile customers into the branch-owned CIM
-- directory. Supabase Auth remains the identity source; cim.customers stores
-- the branch-scoped CRM projection used by Branch Manager search and by the
-- logical customer_id references in Service Requests, CSAT, and Loyalty.
--
-- A customer has no branch at account registration. The NestJS API therefore
-- creates/updates this projection when the customer places an order and has
-- selected a validated branch. Existing Mobile App orders are backfilled below.

ALTER TABLE cim.customers
  ADD COLUMN IF NOT EXISTS auth_user_id uuid;

-- A mobile auth identity has at most one live projection per branch. PostgreSQL
-- permits multiple NULLs in this unique index, so staff-created profiles (whose
-- auth_user_id is NULL) remain unrestricted.
CREATE UNIQUE INDEX IF NOT EXISTS customers_branch_auth_user_id_uidx
  ON cim.customers (branch_id, auth_user_id);

-- Customer-owned history resolves profiles by auth identity across branches.
-- auth_user_id is a logical reference to auth.users.id, so it gets an explicit
-- lookup index in the same migration. No FK constraint is added by design.
CREATE INDEX IF NOT EXISTS customers_auth_user_id_idx
  ON cim.customers (auth_user_id);

-- Before this migration, Mobile App orders stored auth.users.id directly in
-- srd.service_requests.customer_id. Use the newest order snapshot for each
-- (branch, auth user) pair to create the corresponding self-registered profile.
WITH latest_mobile_customer AS (
  SELECT DISTINCT ON (sr.branch_id, sr.customer_id)
    sr.branch_id,
    sr.customer_id AS auth_user_id,
    sr.customer_name,
    sr.customer_contact,
    sr.delivery_address,
    sr.requested_at
  FROM srd.service_requests sr
  WHERE sr.order_source = 'Mobile App'
    AND sr.customer_id IS NOT NULL
    AND sr.deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM cim.customers existing_by_id
      WHERE existing_by_id.id = sr.customer_id
    )
  ORDER BY sr.branch_id, sr.customer_id, sr.requested_at DESC
)
INSERT INTO cim.customers (
  branch_id,
  auth_user_id,
  name,
  contact_number,
  delivery_address,
  registration_source,
  created_at,
  updated_at,
  deleted_at
)
SELECT
  branch_id,
  auth_user_id,
  customer_name,
  customer_contact,
  delivery_address,
  'self-registered',
  requested_at,
  now(),
  NULL
FROM latest_mobile_customer
ON CONFLICT (branch_id, auth_user_id) DO UPDATE SET
  name = EXCLUDED.name,
  contact_number = EXCLUDED.contact_number,
  delivery_address = EXCLUDED.delivery_address,
  registration_source = 'self-registered',
  updated_at = now(),
  deleted_at = NULL;

-- Replace the legacy auth.users id on Mobile App orders with the new branch CIM
-- profile id. The denormalized order snapshot remains unchanged.
UPDATE srd.service_requests sr
SET customer_id = customer.id,
    updated_at = now()
FROM cim.customers customer
WHERE sr.order_source = 'Mobile App'
  AND sr.customer_id = customer.auth_user_id
  AND sr.branch_id = customer.branch_id
  AND customer.deleted_at IS NULL;
