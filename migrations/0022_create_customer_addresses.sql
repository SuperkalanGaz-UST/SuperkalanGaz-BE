-- 0022_create_customer_addresses.sql
-- Reusable delivery addresses for authenticated customer mobile accounts.
-- Ownership is the verified auth.users subject; no client-supplied customer or
-- branch scope is accepted. No FK constraints by project convention.
CREATE TABLE IF NOT EXISTS cim.customer_addresses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id    uuid             NOT NULL,
  label           text             NOT NULL,
  full_address    text             NOT NULL,
  province        text             NOT NULL,
  city            text             NOT NULL,
  barangay        text             NOT NULL,
  street          text             NOT NULL,
  landmark        text,
  contact_number  text             NOT NULL,
  latitude        double precision,
  longitude       double precision,
  created_at      timestamptz      NOT NULL DEFAULT now(),
  updated_at      timestamptz      NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);

-- Some development databases already contain an unused draft of this table
-- with customer_id / branch_id / line1 / is_default columns. CREATE TABLE IF
-- NOT EXISTS does not reconcile schemas, so upgrade that draft in place without
-- deleting it. The legacy reference columns remain available for audit/mapping,
-- but are nullable because a self-registered mobile customer does not have a
-- branch-owned cim.customers row before selecting a delivery branch.
ALTER TABLE cim.customer_addresses
  ADD COLUMN IF NOT EXISTS auth_user_id uuid,
  ADD COLUMN IF NOT EXISTS full_address text,
  ADD COLUMN IF NOT EXISTS street text,
  ADD COLUMN IF NOT EXISTS contact_number text,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'cim'
      AND table_name = 'customer_addresses'
      AND column_name = 'customer_id'
  ) THEN
    ALTER TABLE cim.customer_addresses ALTER COLUMN customer_id DROP NOT NULL;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'cim'
      AND table_name = 'customer_addresses'
      AND column_name = 'branch_id'
  ) THEN
    ALTER TABLE cim.customer_addresses ALTER COLUMN branch_id DROP NOT NULL;
    CREATE INDEX IF NOT EXISTS customer_addresses_branch_id_idx
      ON cim.customer_addresses (branch_id);
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'cim'
      AND table_name = 'customer_addresses'
      AND column_name = 'line1'
  ) THEN
    ALTER TABLE cim.customer_addresses ALTER COLUMN line1 DROP NOT NULL;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'cim'
      AND table_name = 'customer_addresses'
      AND column_name = 'is_default'
  ) THEN
    ALTER TABLE cim.customer_addresses ALTER COLUMN is_default DROP NOT NULL;
  END IF;
END $$;

-- Ownership and required address details cannot be inferred for rows created by
-- the old draft. Fail visibly instead of fabricating an auth owner or contact.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM cim.customer_addresses
    WHERE auth_user_id IS NULL
       OR full_address IS NULL
       OR street IS NULL
       OR contact_number IS NULL
  ) THEN
    RAISE EXCEPTION
      'Legacy customer_addresses rows require explicit owner/contact backfill before migration 0022';
  END IF;
END $$;

ALTER TABLE cim.customer_addresses
  ALTER COLUMN auth_user_id SET NOT NULL,
  ALTER COLUMN full_address SET NOT NULL,
  ALTER COLUMN street SET NOT NULL,
  ALTER COLUMN contact_number SET NOT NULL,
  ALTER COLUMN latitude TYPE double precision USING latitude::double precision,
  ALTER COLUMN longitude TYPE double precision USING longitude::double precision;

CREATE INDEX IF NOT EXISTS customer_addresses_auth_user_id_idx
  ON cim.customer_addresses (auth_user_id);

CREATE INDEX IF NOT EXISTS customer_addresses_deleted_at_idx
  ON cim.customer_addresses (deleted_at);
