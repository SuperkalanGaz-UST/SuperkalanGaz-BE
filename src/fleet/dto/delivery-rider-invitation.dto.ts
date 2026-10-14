import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class ListDeliveryRiderInvitationsQuery {
  @IsOptional()
  @IsUUID()
  branchId?: string;
}

export class DeliveryRiderInvitationTokenDto {
  @IsString()
  @MinLength(32)
  @MaxLength(256)
  token!: string;
}

export class CreateDeliveryRiderAccountDto extends DeliveryRiderInvitationTokenDto {
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password!: string;
}

export class CreateDeliveryRiderSessionAccountDto {
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password!: string;
}

export class VerifyDeliveryRiderSessionMobileDto {
  @Matches(/^\d{6}$/, { message: 'Enter the 6-digit verification code' })
  code!: string;
}

export class RevokeDeliveryRiderInvitationDto {
  @IsString()
  @MinLength(3)
  @MaxLength(300)
  reason!: string;
}

export class SetDeliveryRiderAvailabilityDto {
  @IsBoolean()
  available!: boolean;
}
