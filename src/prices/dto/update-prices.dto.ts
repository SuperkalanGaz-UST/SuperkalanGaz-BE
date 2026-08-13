import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsNumber,
  Min,
  ValidateNested,
} from 'class-validator';

export const CYLINDER_SIZES = ['50kg', '22kg', '11kg', '5kg', '2.7kg'] as const;
export type CylinderSize = (typeof CYLINDER_SIZES)[number];

export class PriceInputDto {
  @IsIn([...CYLINDER_SIZES])
  cylinderSize!: CylinderSize;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  unitPrice!: number;
}

export class UpdatePricesDto {
  @IsArray()
  @ArrayMinSize(CYLINDER_SIZES.length)
  @ArrayMaxSize(CYLINDER_SIZES.length)
  @ValidateNested({ each: true })
  @Type(() => PriceInputDto)
  prices!: PriceInputDto[];
}
