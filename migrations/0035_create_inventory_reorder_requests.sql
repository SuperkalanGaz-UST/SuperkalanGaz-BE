-- 0035_create_inventory_reorder_requests.sql
-- Stage 2 of the Inventory backend (see 0034_create_inventory_stock_levels.sql
-- for Stage 1 / context). Tracks a branch's reorder requests against the
-- shared LPG catalog (srd.products). Marking a request Delivered credits
-- inventory.stock_levels through the same atomic upsert Manual Stock Intake
-- uses, so a delivered reorder doesn't also need a separate manual intake.
--
-- ponytail: there's no separate approver role/UI in this codebase yet, so
-- every status transition (Approved/Delivered/Cancelled) is self-serve by
-- the requesting branch manager. Add a real approval actor when a role for
-- it exists.

CREATE TABLE inventory.reorder_requests (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id          uuid        NOT NULL,
  product_id         uuid        NOT NULL,
  requested_qty      integer     NOT NULL,
  status             text        NOT NULL DEFAULT 'Pending',
  requested_by       uuid        NOT NULL,
  requested_by_name  text        NOT NULL,
  requested_at       timestamptz NOT NULL DEFAULT now(),
  decided_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,
  CONSTRAINT reorder_requests_qty_check CHECK (requested_qty > 0),
  CONSTRAINT reorder_requests_status_check
    CHECK (status IN ('Pending', 'Approved', 'Delivered', 'Cancelled'))
);

CREATE INDEX IF NOT EXISTS reorder_requests_branch_id_idx
  ON inventory.reorder_requests (branch_id);
CREATE INDEX IF NOT EXISTS reorder_requests_product_id_idx
  ON inventory.reorder_requests (product_id);
CREATE INDEX IF NOT EXISTS reorder_requests_status_idx
  ON inventory.reorder_requests (status);
CREATE INDEX IF NOT EXISTS reorder_requests_deleted_at_idx
  ON inventory.reorder_requests (deleted_at);
