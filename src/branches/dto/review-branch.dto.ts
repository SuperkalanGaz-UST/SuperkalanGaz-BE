import { IsIn, IsOptional, IsString } from 'class-validator';

/**
 * Franchise Admin review action on a registered branch. Maps to the
 * core.branches.review_status CHECK ('none' | 'flagged' | 'cleared'):
 *   - 'flag'  → review_status = 'flagged' (optionally with a note)
 *   - 'clear' → review_status = 'cleared'
 * The service also stamps reviewed_by (the acting FA) and reviewed_at.
 */
export class ReviewBranchDto {
  @IsIn(['flag', 'clear'])
  action!: 'flag' | 'clear';

  @IsOptional()
  @IsString()
  note?: string;
}
