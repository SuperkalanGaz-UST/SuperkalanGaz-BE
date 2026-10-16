-- Allow Salary & Wages through the existing operational expense workflow.
BEGIN;

ALTER TABLE core.operational_expenses
  DROP CONSTRAINT operational_expenses_category_check;

ALTER TABLE core.operational_expenses
  ADD CONSTRAINT operational_expenses_category_check CHECK (
    category IN (
      'Gasoline, Fuel & Oil',
      'Repairs & Maintenance',
      'Utilities',
      'Communication',
      'Branch Supplies',
      'Facility Costs',
      'Salary & Wages'
    )
  );

COMMIT;
