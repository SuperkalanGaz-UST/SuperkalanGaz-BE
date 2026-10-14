import { IsInt, Min } from 'class-validator';

export class UpdateCatalogStockDto {
  @IsInt()
  @Min(0)
  stockQty!: number;
}
