import { IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

/**
 * Customer-submitted CSAT rating for a completed delivery.
 * The branch_id and customer_id are derived server-side from the authenticated
 * Principal and the linked Service Request — never trusted from the client
 * (AGENTS.md §5).
 */
export class CreateRatingDto {
  /** The delivered Service Request the customer is rating. */
  @IsUUID()
  serviceRequestId!: string;

  /** Star rating 1–5 (DB CHECK-constrained to the same range). */
  @IsInt()
  @Min(1)
  @Max(5)
  stars!: number;

  /** Optional free-text feedback. */
  @IsOptional()
  @IsString()
  comment?: string;
}
