import { IsOptional, IsUUID } from 'class-validator';

/** A selected UUID narrows the guard-resolved live branch scope. */
export class VehicleBranchQuery {
  @IsOptional()
  @IsUUID()
  branchId?: string;
}
