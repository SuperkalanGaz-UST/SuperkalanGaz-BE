-- 0027_make_loyalty_ledgers_authoritative.sql
-- Reproducible Loyalty Program Monitoring foundation for the two deliberately
-- separate tracks:
--   household_points     -> points account + immutable point transactions
--   commercial_30plus1   -> purchase counter + immutable purchase records
--
-- Existing deployments already have some of these tables. Every operation is
-- additive/idempotent so this migration both creates a fresh schema and closes
-- integrity/index gaps on an existing one. There are no database foreign keys;
-- logical references are validated in the NestJS service layer (AGENTS.md §6).

CREATE SCHEMA IF NOT EXISTS loyalty;

CREATE TABLE IF NOT EXISTS loyalty.catalog_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id     uuid        NOT NULL,
  name          text        NOT NULL,
  description   text,
  points_cost   integer     NOT NULL CHECK (points_cost >= 0),
  stock_qty     integer     NOT NULL DEFAULT 0 CHECK (stock_qty >= 0),
  is_active     boolean     NOT NULL DEFAULT true,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS loyalty.household_loyalty_accounts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id    uuid        NOT NULL,
  branch_id      uuid        NOT NULL,
  points_balance integer     NOT NULL DEFAULT 0 CHECK (points_balance >= 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS loyalty.household_point_transactions (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id                 uuid        NOT NULL,
  customer_id                uuid        NOT NULL,
  branch_id                  uuid        NOT NULL,
  type                       text        NOT NULL CHECK (type IN ('earn', 'redeem', 'expire', 'adjust')),
  points_delta               integer     NOT NULL,
  source_service_request_id  uuid,
  redemption_id              uuid,
  source_point_transaction_id uuid,
  earned_at                  timestamptz,
  expires_at                 timestamptz,
  created_at                 timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS loyalty.commercial_loyalty_accounts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id         uuid        NOT NULL,
  branch_id           uuid        NOT NULL,
  current_cycle_count integer     NOT NULL DEFAULT 0 CHECK (current_cycle_count >= 0 AND current_cycle_count < 30),
  completed_cycles    integer     NOT NULL DEFAULT 0 CHECK (completed_cycles >= 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS loyalty.commercial_purchase_records (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         uuid        NOT NULL,
  customer_id        uuid        NOT NULL,
  branch_id          uuid        NOT NULL,
  service_request_id uuid        NOT NULL,
  cycle_number       integer     NOT NULL CHECK (cycle_number >= 1),
  counted_at         timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS loyalty.redemptions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id          uuid        NOT NULL,
  customer_id        uuid        NOT NULL,
  track              text        NOT NULL CHECK (track IN ('household_points', 'commercial_30plus1')),
  catalog_item_id    uuid,
  reward_description text,
  points_spent       integer,
  status             text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'fulfilled', 'cancelled')),
  requested_at       timestamptz NOT NULL,
  approved_by        uuid,
  approved_at        timestamptz,
  rejected_reason    text,
  fulfilled_at       timestamptz,
  redemption_code    text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Existing loyalty tables need the expiry source link introduced above.
ALTER TABLE loyalty.household_point_transactions
  ADD COLUMN IF NOT EXISTS source_point_transaction_id uuid;

-- Account type is copied from protected Auth app_metadata into each branch CIM
-- projection. Delivery uses this server-owned value to select exactly one track.
ALTER TABLE cim.customers
  ADD COLUMN IF NOT EXISTS account_type text NOT NULL DEFAULT 'household';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'cim.customers'::regclass
      AND conname = 'customers_account_type_check'
  ) THEN
    ALTER TABLE cim.customers
      ADD CONSTRAINT customers_account_type_check
      CHECK (account_type IN ('household', 'commercial'));
  END IF;
END $$;

-- Existing self-registered profiles were created before the protected claim was
-- available. Backfill once from Auth metadata; subsequent writes use app_metadata.
UPDATE cim.customers customer
SET account_type = CASE
  WHEN auth_user.raw_app_meta_data->>'account_type' IN ('household', 'commercial')
    THEN auth_user.raw_app_meta_data->>'account_type'
  WHEN auth_user.raw_user_meta_data->>'account_type' IN ('household', 'commercial')
    THEN auth_user.raw_user_meta_data->>'account_type'
  ELSE customer.account_type
END,
updated_at = now()
FROM auth.users auth_user
WHERE customer.auth_user_id = auth_user.id
  AND customer.account_type IS DISTINCT FROM CASE
    WHEN auth_user.raw_app_meta_data->>'account_type' IN ('household', 'commercial')
      THEN auth_user.raw_app_meta_data->>'account_type'
    WHEN auth_user.raw_user_meta_data->>'account_type' IN ('household', 'commercial')
      THEN auth_user.raw_user_meta_data->>'account_type'
    ELSE customer.account_type
  END;

-- Point rates live on the existing branch record to preserve the locked table
-- count and keep configuration branch-scoped. The API validates this JSON shape.
ALTER TABLE core.branches
  ADD COLUMN IF NOT EXISTS loyalty_point_rates jsonb NOT NULL DEFAULT
    '{"2.7kg":5,"5kg":10,"11kg":15,"22kg":20,"50kg":25}'::jsonb;

-- One account per customer per branch and one delivery event per ledger entry.
CREATE UNIQUE INDEX IF NOT EXISTS household_accounts_customer_branch_uidx
  ON loyalty.household_loyalty_accounts (customer_id, branch_id);
CREATE UNIQUE INDEX IF NOT EXISTS commercial_accounts_customer_branch_uidx
  ON loyalty.commercial_loyalty_accounts (customer_id, branch_id);
CREATE UNIQUE INDEX IF NOT EXISTS household_earn_service_request_uidx
  ON loyalty.household_point_transactions (source_service_request_id)
  WHERE type = 'earn' AND source_service_request_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS household_expiry_source_uidx
  ON loyalty.household_point_transactions (source_point_transaction_id)
  WHERE type = 'expire' AND source_point_transaction_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS household_redeem_redemption_uidx
  ON loyalty.household_point_transactions (redemption_id)
  WHERE type = 'redeem' AND redemption_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS commercial_purchase_service_request_uidx
  ON loyalty.commercial_purchase_records (service_request_id);
CREATE UNIQUE INDEX IF NOT EXISTS redemptions_redemption_code_key
  ON loyalty.redemptions (redemption_code)
  WHERE redemption_code IS NOT NULL;

-- Explicit indexes for every logical reference / lookup column (AGENTS.md §6).
CREATE INDEX IF NOT EXISTS catalog_items_branch_id_idx ON loyalty.catalog_items (branch_id);
CREATE INDEX IF NOT EXISTS catalog_items_created_by_idx ON loyalty.catalog_items (created_by);
CREATE INDEX IF NOT EXISTS household_accounts_customer_id_idx ON loyalty.household_loyalty_accounts (customer_id);
CREATE INDEX IF NOT EXISTS household_accounts_branch_id_idx ON loyalty.household_loyalty_accounts (branch_id);
CREATE INDEX IF NOT EXISTS household_transactions_account_id_idx ON loyalty.household_point_transactions (account_id);
CREATE INDEX IF NOT EXISTS household_transactions_customer_id_idx ON loyalty.household_point_transactions (customer_id);
CREATE INDEX IF NOT EXISTS household_transactions_branch_id_idx ON loyalty.household_point_transactions (branch_id);
CREATE INDEX IF NOT EXISTS household_transactions_service_request_id_idx ON loyalty.household_point_transactions (source_service_request_id);
CREATE INDEX IF NOT EXISTS household_transactions_redemption_id_idx ON loyalty.household_point_transactions (redemption_id);
CREATE INDEX IF NOT EXISTS household_transactions_source_point_idx ON loyalty.household_point_transactions (source_point_transaction_id);
CREATE INDEX IF NOT EXISTS household_transactions_expires_at_idx ON loyalty.household_point_transactions (expires_at);
CREATE INDEX IF NOT EXISTS commercial_accounts_customer_id_idx ON loyalty.commercial_loyalty_accounts (customer_id);
CREATE INDEX IF NOT EXISTS commercial_accounts_branch_id_idx ON loyalty.commercial_loyalty_accounts (branch_id);
CREATE INDEX IF NOT EXISTS commercial_purchases_account_id_idx ON loyalty.commercial_purchase_records (account_id);
CREATE INDEX IF NOT EXISTS commercial_purchases_customer_id_idx ON loyalty.commercial_purchase_records (customer_id);
CREATE INDEX IF NOT EXISTS commercial_purchases_branch_id_idx ON loyalty.commercial_purchase_records (branch_id);
CREATE INDEX IF NOT EXISTS commercial_purchases_service_request_id_idx ON loyalty.commercial_purchase_records (service_request_id);
CREATE INDEX IF NOT EXISTS redemptions_branch_status_idx ON loyalty.redemptions (branch_id, status);
CREATE INDEX IF NOT EXISTS redemptions_customer_id_idx ON loyalty.redemptions (customer_id);
CREATE INDEX IF NOT EXISTS redemptions_catalog_item_id_idx ON loyalty.redemptions (catalog_item_id);
CREATE INDEX IF NOT EXISTS redemptions_approved_by_idx ON loyalty.redemptions (approved_by);

-- Legacy/demo setup changed cached balances directly. Preserve those values but
-- make the immutable ledger authoritative by recording a one-time adjustment.
INSERT INTO loyalty.household_point_transactions (
  account_id,
  customer_id,
  branch_id,
  type,
  points_delta,
  source_service_request_id,
  redemption_id,
  source_point_transaction_id,
  earned_at,
  expires_at,
  created_at
)
SELECT
  account.id,
  account.customer_id,
  account.branch_id,
  'adjust',
  account.points_balance - COALESCE(ledger.total, 0),
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  now()
FROM loyalty.household_loyalty_accounts account
LEFT JOIN (
  SELECT account_id, SUM(points_delta)::integer AS total
  FROM loyalty.household_point_transactions
  GROUP BY account_id
) ledger ON ledger.account_id = account.id
WHERE account.points_balance <> COALESCE(ledger.total, 0);
