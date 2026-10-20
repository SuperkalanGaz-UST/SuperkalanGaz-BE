import { IsOptional, IsUUID } from 'class-validator';

/** Client-selected context may only narrow the guard-resolved branch UUIDs. */
export class BranchSelectionQuery {
  @IsOptional()
  @IsUUID()
  branchId?: string;
}
