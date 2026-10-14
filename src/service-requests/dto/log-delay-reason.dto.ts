import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

/** The delay reason dropdown values (story BM-011: "dropdown + optional
 * free-text"). Single source of truth, reused by the validator below. */
export const DELAY_REASON_CATEGORIES = [
  'traffic',
  'weather',
  'customer_unavailable',
  'vehicle_issue',
  'address_issue',
  'other',
] as const;

export type DelayReasonCategory = (typeof DELAY_REASON_CATEGORIES)[number];

/**
 * Payload for POST /service-requests/:id/delay-reason — the Branch Manager
 * logging why a request is running late (story BM-011). The dropdown category
 * and the optional free-text note are combined server-side into the single
 * `delay_reason` display string (AGENTS.md §5 — the server owns the persisted
 * shape, the client only supplies the two raw inputs).
 */
export class LogDelayReasonDto {
  @IsIn(DELAY_REASON_CATEGORIES as unknown as string[])
  reasonCategory!: DelayReasonCategory;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
