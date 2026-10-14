import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * Payload for PATCH /loyalty/settings — toggles the caller's branch loyalty
 * Dual Authorization (story BM-013). true => redemption requests enter the
 * pending Rewards Claiming queue for manual approve/reject; false => requests are
 * auto-approved and coded on creation, bypassing the queue.
 */
export class LoyaltyPointRatesDto {
  @IsInt() @Min(0) @Max(10_000)
  '2.7kg'!: number;

  @IsInt() @Min(0) @Max(10_000)
  '5kg'!: number;

  @IsInt() @Min(0) @Max(10_000)
  '11kg'!: number;

  @IsInt() @Min(0) @Max(10_000)
  '22kg'!: number;

  @IsInt() @Min(0) @Max(10_000)
  '50kg'!: number;
}

export class UpdateLoyaltySettingsDto {
  @IsOptional()
  @IsBoolean()
  dualAuth?: boolean;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => LoyaltyPointRatesDto)
  pointRates?: LoyaltyPointRatesDto;
}
