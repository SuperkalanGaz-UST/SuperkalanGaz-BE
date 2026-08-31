import { IsIn, IsOptional, IsUUID } from 'class-validator';
import { RIDER_STATUSES, RiderStatus } from '../rider.entity';

/**
 * Query for GET /riders. The dispatch dropdown calls this with
 * ?status=Available to list assignable riders. The filter is validated against
 * the allowed status set (mirrors ListUsersQuery); it can only NARROW the
 * caller's own-branch results, never widen them (AGENTS.md §5).
 */
export class ListRidersQuery {
  /**
   * Branch Owner views must carry the selected branch UUID. The Fleet service
   * verifies it against the Principal's live authorized scope before querying.
   */
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @IsOptional()
  @IsIn(RIDER_STATUSES as unknown as RiderStatus[])
  status?: RiderStatus;
}
