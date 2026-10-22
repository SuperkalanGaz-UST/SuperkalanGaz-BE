import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

export class IntakeRewardStockDto {
  @IsUUID()
  catalogItemId!: string;

  @IsInt()
  @Min(1)
  @Max(2147483647)
  receivedQty!: number;

  /** May narrow verified scope; it never grants access to another branch. */
  @IsOptional()
  @IsUUID()
  branchId?: string;
}
