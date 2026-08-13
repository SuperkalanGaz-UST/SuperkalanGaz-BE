import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

/** Resolution filters for the CSAT queue: the two lifecycle states plus 'all'
 * (no filter). Single source of truth, reused by the validator below. */
export const RESOLUTION_FILTERS = ['Open', 'Resolved', 'all'] as const;

export type ResolutionFilter = (typeof RESOLUTION_FILTERS)[number];

/**
 * Query for GET /csat/ratings. The Branch Manager's follow-up queue (story
 * BM-038) passes ?maxStars=3 to surface only the low-CSAT band (1–3 stars) and
 * ?resolution=Open to see what still needs actioning — both defaults. 'all'
 * drops the resolution filter; omitting maxStars shows every rating (the BM may
 * want the full picture for context).
 *
 * Neither value can widen scope — results are always the caller's own branch(es)
 * (AGENTS.md §5).
 */
export class ListRatingsQuery {
  /** Inclusive upper bound on stars. Defaults to 3 (the low-CSAT band) in the
   * service. Constrained to the DB's own 1–5 rating range. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  maxStars?: number;

  @IsOptional()
  @IsIn(RESOLUTION_FILTERS as unknown as string[])
  resolution?: ResolutionFilter;
}
