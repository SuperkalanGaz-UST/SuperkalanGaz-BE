import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsIn,
  IsString,
  IsUUID,
  Matches,
  Min,
} from 'class-validator';
import { CylinderSize } from '../../prices/dto/update-prices.dto';
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

  @IsString()
  @IsNotEmpty()
  @Matches(/^(2\.7kg|5kg|11kg|22kg|50kg)$/)
  cylinderSize!: CylinderSize;

  @IsInt()
  @Min(1)
  quantity!: number;

  @IsIn(['Cash on Delivery', 'PayMongo'])
  paymentMethod!: PaymentMethod;

  @IsOptional()
  @IsString()
  specialInstructions?: string;
}
