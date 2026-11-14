import { IsIn, IsInt, Max, Min } from 'class-validator';
import { CYLINDER_SIZES, CylinderSize } from '../../prices/dto/update-prices.dto';

export class ServiceRequestItemDto {
  @IsIn([...CYLINDER_SIZES])
  cylinderSize!: CylinderSize;

  @IsInt()
  @Min(1)
  @Max(2147483647)
  quantity!: number;
}
