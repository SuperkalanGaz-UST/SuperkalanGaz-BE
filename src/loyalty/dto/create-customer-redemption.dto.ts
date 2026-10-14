import { IsUUID } from 'class-validator';

export class CreateCustomerRedemptionDto {
  @IsUUID()
  catalogItemId!: string;
}

export class CreateCustomerCommercialRedemptionDto {
  @IsUUID()
  branchId!: string;
}
