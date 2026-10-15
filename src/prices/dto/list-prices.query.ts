import { IsIn, IsOptional } from 'class-validator';
import { REGION_CODES, RegionCode } from '../philippine-regions';

export class ListPricesQuery {
  @IsOptional()
  @IsIn(REGION_CODES)
  regionCode?: RegionCode;
}
