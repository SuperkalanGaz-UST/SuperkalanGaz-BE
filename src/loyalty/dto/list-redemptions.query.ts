import { IsIn, IsOptional } from 'class-validator';

/**
 * The queue filter values for GET /loyalty/redemptions. The five lifecycle states
 * plus 'all' (no status filter). Kept as a single source of truth reused by the
 * query validator below — mirrors RIDER_STATUSES.
 */
export const REDEMPTION_STATUS_FILTERS = [
  'pending',
  'approved',
  'rejected',
  'fulfilled',
  'cancelled',
  'all',
] as const;

export type RedemptionStatusFilter = (typeof REDEMPTION_STATUS_FILTERS)[number];

/**
 * The two loyalty tracks the queue can show, matching the DB CHECK constraint
 * redemptions_track_check. A request always targets exactly ONE track — the two
 * are kept separate (AGENTS.md §8a) and never mixed in a single list.
 */
export const REDEMPTION_TRACKS = ['household_points', 'commercial_30plus1'] as const;

export type RedemptionTrack = (typeof REDEMPTION_TRACKS)[number];

/**
 * Query for GET /loyalty/redemptions. The approval queue passes ?status=pending
 * (the default when omitted) to show what needs actioning; other values narrow to
 * a lifecycle state, and 'all' drops the status filter entirely. ?track selects
 * which loyalty track to view (default 'household_points'). Neither value can
 * widen scope — results are always the caller's own-branch rows (AGENTS.md §5).
 */
export class ListRedemptionsQuery {
  @IsOptional()
  @IsIn(REDEMPTION_STATUS_FILTERS as unknown as string[])
  status?: RedemptionStatusFilter;

  @IsOptional()
  @IsIn(REDEMPTION_TRACKS as unknown as string[])
  track?: RedemptionTrack;
}
