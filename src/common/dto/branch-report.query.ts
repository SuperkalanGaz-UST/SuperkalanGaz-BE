import { IsOptional, IsUUID, Matches } from 'class-validator';

/**
 * Shared query contract for branch reports. `branchId` may only narrow the
 * caller's JWT-derived scope; each domain service verifies membership before
 * using it in a query.
 */
export class BranchReportQuery {
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'from must use YYYY-MM-DD format',
  })
  from!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'to must use YYYY-MM-DD format',
  })
  to!: string;

  @IsOptional()
  @IsUUID()
  branchId?: string;
}
