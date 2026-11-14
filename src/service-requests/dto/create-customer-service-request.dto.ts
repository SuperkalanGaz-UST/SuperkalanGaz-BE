import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  Max,
  ValidateIf,
  ValidateNested,
  IsNotEmpty,
  IsOptional,
  IsIn,
  IsString,
  IsUUID,
  Matches,
  Min,
} from 'class-validator';
import { CYLINDER_SIZES, CylinderSize } from '../../prices/dto/update-prices.dto';
import { ServiceRequestItemDto } from './service-request-item.dto';
import { PaymentMethod } from '../service-request.entity';

const PH_MOBILE_E164 = /^\+639\d{9}$/;

/**
 * Customer-app order payload. The caller's auth subject becomes customer_id;
 * branch_id is chosen from the public branch list and validated server-side.
 */
export class CreateCustomerServiceRequestDto {
  @IsUUID()
  branchId!: string;

  @IsString()
  @IsNotEmpty()
  customerName!: string;

  @IsString()
  @IsNotEmpty()
  @Matches(PH_MOBILE_E164, { message: 'customerContact must be a valid PH mobile in +639XXXXXXXXX form' })
  customerContact!: string;

  @IsString()
  @IsNotEmpty()
  deliveryAddress!: string;

  @ValidateIf(dto => dto.items === undefined || dto.cylinderSize !== undefined)
  @IsIn([...CYLINDER_SIZES])
  cylinderSize?: CylinderSize;

  @ValidateIf(dto => dto.items === undefined || dto.quantity !== undefined)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  quantity?: number;

  @ValidateIf((_dto, value: unknown) => value !== undefined)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(CYLINDER_SIZES.length)
  @ValidateNested({ each: true })
  @Type(() => ServiceRequestItemDto)
  items?: ServiceRequestItemDto[];

  @IsIn(['Cash on Delivery', 'PayMongo'])
  paymentMethod!: PaymentMethod;

  @IsOptional()
  @IsString()
  specialInstructions?: string;
}
