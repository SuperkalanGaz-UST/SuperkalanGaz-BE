-- 0036_create_inventory_stock_check_logs.sql
-- Up
CREATE TABLE IF NOT EXISTS inventory.stock_check_logs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id      uuid        NOT NULL,
  checked_by     uuid        NOT NULL,
  checked_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS stock_check_logs_branch_checked_at_idx
  ON inventory.stock_check_logs (branch_id, checked_at);

-- Down (run manually if needed to revert)
-- DROP TABLE IF EXISTS inventory.stock_check_logs;
