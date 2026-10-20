-- Client-approved Owner expense extension. Application guards enforce access;
-- this table is not exposed through PostgREST. No FK constraints or hard deletes.
BEGIN;
CREATE TABLE IF NOT EXISTS core.salary_expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  staff_name text NOT NULL,
  staff_role text NOT NULL CHECK (staff_role IN ('branch-manager', 'driver')),
  period_start date NOT NULL,
  period_end date NOT NULL CHECK (period_end >= period_start),
  regular_hours numeric(10,2) NOT NULL CHECK (regular_hours >= 0),
  hourly_rate numeric(12,2) NOT NULL CHECK (hourly_rate > 0),
  overtime_hours numeric(10,2) NOT NULL CHECK (overtime_hours >= 0),
  overtime_hourly_rate numeric(12,2) NOT NULL CHECK (overtime_hourly_rate >= 0),
  regular_pay numeric(12,2) NOT NULL CHECK (regular_pay >= 0),
  overtime_pay numeric(12,2) NOT NULL CHECK (overtime_pay >= 0),
  total numeric(12,2) NOT NULL CHECK (total > 0 AND total = regular_pay + overtime_pay),
  request_id uuid NOT NULL,
  recorded_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CHECK (overtime_hours = 0 OR overtime_hourly_rate > 0)
);
CREATE INDEX IF NOT EXISTS salary_expenses_branch_id_idx ON core.salary_expenses (branch_id);
CREATE INDEX IF NOT EXISTS salary_expenses_staff_id_idx ON core.salary_expenses (staff_id);
CREATE INDEX IF NOT EXISTS salary_expenses_recorded_by_idx ON core.salary_expenses (recorded_by);
CREATE INDEX IF NOT EXISTS salary_expenses_request_id_idx ON core.salary_expenses (request_id);
CREATE INDEX IF NOT EXISTS salary_expenses_branch_month_idx ON core.salary_expenses (branch_id, period_end) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS salary_expenses_retry_idx ON core.salary_expenses (branch_id, recorded_by, request_id);
COMMIT;
