import { IsEmail, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';

export class CreateDeliveryRiderInvitationDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  recipientName!: string;

  @IsEmail()
  @MaxLength(254)
  email!: string;

  /** Canonical storage boundary; clients may format input but never this value. */
  @Matches(/^\+639\d{9}$/, { message: 'Enter a valid PH mobile number' })
  mobile!: string;

  @IsUUID()
  branchId!: string;
}
