import { IsOptional, IsUUID } from 'class-validator';

/**
 * Branch context for a Branch Owner operation. The UUID may only narrow the
 * protected scope already resolved by AuthGuard; it is never trusted directly.
 */
export class BranchSelectionQuery {
  @IsOptional()
  @IsUUID()
  branchId?: string;
}
