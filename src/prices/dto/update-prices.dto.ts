import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsNumber,
  IsOptional,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { REGION_CODES, RegionCode } from '../philippine-regions';

export const CYLINDER_SIZES = ['50kg', '22kg', '11kg', '5kg', '2.7kg'] as const;
export type CylinderSize = (typeof CYLINDER_SIZES)[number];

export class PriceInputDto {
  @IsIn([...CYLINDER_SIZES])
  cylinderSize!: CylinderSize;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(99999999.99)
  unitPrice!: number;
}

export class UpdatePricesDto {
  @IsOptional()
  @IsIn(REGION_CODES)
  regionCode?: RegionCode;

  @IsArray()
  @ArrayMinSize(CYLINDER_SIZES.length)
  @ArrayMaxSize(CYLINDER_SIZES.length)
  @ValidateNested({ each: true })
  @Type(() => PriceInputDto)
  prices!: PriceInputDto[];
}
