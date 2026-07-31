import { IsIn, IsOptional } from 'class-validator';

/**
 * The queue filter values for GET /loyalty/redemptions. The four lifecycle states
 * plus 'all' (no status filter). Kept as a single source of truth reused by the
 * query validator below — mirrors RIDER_STATUSES.
 */
export const REDEMPTION_STATUS_FILTERS = [
  'pending',
  'approved',
  'rejected',
  'fulfilled',
  'all',
] as const;

export type RedemptionStatusFilter = (typeof REDEMPTION_STATUS_FILTERS)[number];

/**
 * Query for GET /loyalty/redemptions. The approval queue passes ?status=pending
 * (the default when omitted) to show what needs actioning; other values narrow to
 * a lifecycle state, and 'all' drops the status filter entirely. The value can
 * only NARROW the caller's own-branch, household-track results — it can never
 * widen scope (AGENTS.md §5).
 */
export class ListRedemptionsQuery {
  @IsOptional()
  @IsIn(REDEMPTION_STATUS_FILTERS as unknown as string[])
  status?: RedemptionStatusFilter;
}
