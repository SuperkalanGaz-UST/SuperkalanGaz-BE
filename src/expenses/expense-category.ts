export const EXPENSE_CATEGORIES = [
  'Gasoline, Fuel & Oil',
  'Repairs & Maintenance',
  'Utilities',
  'Communication',
  'Branch Supplies',
  'Facility Costs',
  'Salary & Wages',
] as const;

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];
