-- 0034_create_inventory_stock_levels.sql
-- Branch Manager Inventory screen (currently 100% client-side mock — see
-- frontend branch-manager/screens/inventory). Stage 1 of the real backend:
-- per-branch stock levels keyed to the existing shared LPG catalog
-- (srd.products), not a new product list. `inventory` is one of the 7
-- schemas AGENTS.md §6 already names for this domain.
--
-- Project conventions: UUID PK, no FK constraints (branch_id/product_id are
-- logical references, checked in the application layer), explicit indexes on
-- every reference column, and soft delete only. Apply through the Supabase
-- SQL editor before deploying the API that maps this table.
--
-- inventory.stock_levels already existed in the shared dev DB before this
-- migration, created directly against Supabase with no committed migration
-- behind it (quantity_on_hand/low_stock_threshold columns, no capacity or
-- soft-delete concept) — confirmed abandoned and empty (0 rows). Dropped here
-- so this migration becomes the single source of truth for the table's shape.

DROP TABLE IF EXISTS inventory.stock_levels;

CREATE SCHEMA IF NOT EXISTS inventory;

CREATE TABLE inventory.stock_levels (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id      uuid        NOT NULL,
  product_id     uuid        NOT NULL,
  current_qty    integer     NOT NULL DEFAULT 0,
  threshold_qty  integer     NOT NULL DEFAULT 10,
  capacity_qty   integer     NOT NULL DEFAULT 100,
  updated_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  CONSTRAINT stock_levels_current_qty_check CHECK (current_qty >= 0),
  CONSTRAINT stock_levels_threshold_qty_check CHECK (threshold_qty >= 0),
  CONSTRAINT stock_levels_capacity_qty_check CHECK (capacity_qty > 0)
);

-- One live row per (branch, product). PostgreSQL partial unique indexes allow
-- a new row to be created again after a soft-delete of an old one.
CREATE UNIQUE INDEX IF NOT EXISTS stock_levels_branch_product_uidx
  ON inventory.stock_levels (branch_id, product_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS stock_levels_branch_id_idx
  ON inventory.stock_levels (branch_id);
CREATE INDEX IF NOT EXISTS stock_levels_product_id_idx
  ON inventory.stock_levels (product_id);
CREATE INDEX IF NOT EXISTS stock_levels_deleted_at_idx
  ON inventory.stock_levels (deleted_at);
