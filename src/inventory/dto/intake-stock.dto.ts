import { IsInt, IsUUID, Min } from 'class-validator';

/** Manual Stock Intake: adds a received quantity onto a product's current
 * stock for the caller's branch. branchId and updatedBy are server-owned. */
export class IntakeStockDto {
  @IsUUID()
  productId!: string;

  @IsInt()
  @Min(1)
  receivedQty!: number;
}
