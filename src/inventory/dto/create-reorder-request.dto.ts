import { IsInt, IsUUID, Min } from 'class-validator';

export class CreateReorderRequestDto {
  @IsUUID()
  productId!: string;

  @IsInt()
  @Min(10)
  requestedQty!: number;
}
