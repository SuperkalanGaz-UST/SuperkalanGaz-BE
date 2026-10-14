import {
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const PH_MOBILE_E164 = /^\+639\d{9}$/;

/** Full replacement payload for a customer-owned saved delivery address. */
export class SaveCustomerAddressDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  label!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  province!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  city!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  barangay!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(240)
  street!: string;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  landmark?: string;

  @IsString()
  @Matches(PH_MOBILE_E164, {
    message: 'contactNumber must be a valid PH mobile in +639XXXXXXXXX form',
  })
  contactNumber!: string;

  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude?: number;

  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude?: number;
}
