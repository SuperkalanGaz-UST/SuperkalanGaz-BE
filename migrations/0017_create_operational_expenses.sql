-- 0017_create_operational_expenses.sql
-- Client-confirmed branch operational expense logging. Rows live in core because
-- they are branch administration records, not Service Requests or inventory
-- movements. Access is still enforced in the NestJS application layer: every
-- read/write is scoped by the branch_id derived from the verified JWT.
--
-- Project conventions: UUID PK, no FK constraints, explicit indexes on all
-- logical references/lookups, and soft delete only. Apply through the Supabase
-- SQL editor before deploying the API that maps this table.

CREATE SCHEMA IF NOT EXISTS core;

CREATE TABLE IF NOT EXISTS core.operational_expenses (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id      uuid           NOT NULL,
  expense_date   date           NOT NULL,
  reference_no   text,
  category       text           NOT NULL,
  description    text           NOT NULL,
  amount         numeric(12, 2) NOT NULL,
  receipt_name   text,
  recorded_by    uuid           NOT NULL,
  created_at     timestamptz    NOT NULL DEFAULT now(),
  updated_at     timestamptz    NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  CONSTRAINT operational_expenses_amount_positive CHECK (amount > 0),
  CONSTRAINT operational_expenses_category_check CHECK (
    category IN (
      'Gasoline, Fuel & Oil',
      'Repairs & Maintenance',
      'Utilities',
      'Communication',
      'Branch Supplies',
      'Facility Costs'
    )
  )
);

CREATE INDEX IF NOT EXISTS operational_expenses_branch_id_idx
  ON core.operational_expenses (branch_id);

CREATE INDEX IF NOT EXISTS operational_expenses_recorded_by_idx
  ON core.operational_expenses (recorded_by);

CREATE INDEX IF NOT EXISTS operational_expenses_expense_date_idx
  ON core.operational_expenses (expense_date);

CREATE INDEX IF NOT EXISTS operational_expenses_deleted_at_idx
  ON core.operational_expenses (deleted_at);

CREATE INDEX IF NOT EXISTS operational_expenses_branch_month_idx
  ON core.operational_expenses (branch_id, expense_date)
  WHERE deleted_at IS NULL;
