import { IsIn, IsOptional } from 'class-validator';
import { RIDER_STATUSES, RiderStatus } from '../rider.entity';

/**
 * Query for GET /riders. The dispatch dropdown calls this with
 * ?status=Available to list assignable riders. The filter is validated against
 * the allowed status set (mirrors ListUsersQuery); it can only NARROW the
 * caller's own-branch results, never widen them (AGENTS.md §5).
 */
export class ListRidersQuery {
  @IsOptional()
  @IsIn(RIDER_STATUSES as unknown as RiderStatus[])
  status?: RiderStatus;
}
