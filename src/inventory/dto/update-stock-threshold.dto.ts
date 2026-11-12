import { IsInt, IsUUID, Max, Min } from 'class-validator';

export class UpdateStockThresholdDto {
  @IsUUID()
  branchId!: string;

  @IsUUID()
  productId!: string;

  @IsInt()
  @Min(0)
  @Max(10_000)
  thresholdQty!: number;
}
