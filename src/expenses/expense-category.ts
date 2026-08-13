export const EXPENSE_CATEGORIES = [
  'Gasoline, Fuel & Oil',
  'Repairs & Maintenance',
  'Utilities',
  'Communication',
  'Branch Supplies',
  'Facility Costs',
] as const;

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];
