-- Add reward stock targets without moving or duplicating the catalog's stock_qty.
-- Apply before deploying reward inventory endpoints. Existing LPG/reward rows are untouched.
CREATE TABLE IF NOT EXISTS inventory.reward_stock_levels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL,
  catalog_item_id uuid NOT NULL,
  threshold_qty integer NOT NULL DEFAULT 10 CHECK (threshold_qty >= 0),
  capacity_qty integer NOT NULL DEFAULT 100 CHECK (capacity_qty > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

-- Logical references only; branch/catalog membership is enforced by the API.
CREATE UNIQUE INDEX IF NOT EXISTS reward_stock_levels_branch_item_uidx
  ON inventory.reward_stock_levels (branch_id, catalog_item_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS reward_stock_levels_branch_idx ON inventory.reward_stock_levels (branch_id);
CREATE INDEX IF NOT EXISTS reward_stock_levels_catalog_item_idx ON inventory.reward_stock_levels (catalog_item_id);

-- Targets are additive metadata. Catalog stock remains authoritative for intake/redemption.
INSERT INTO inventory.reward_stock_levels (branch_id, catalog_item_id)
SELECT branch_id, id FROM loyalty.catalog_items WHERE is_active = true
ON CONFLICT (branch_id, catalog_item_id) WHERE deleted_at IS NULL DO NOTHING;
