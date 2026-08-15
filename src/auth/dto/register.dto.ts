import { IsEmail, IsIn, IsNotEmpty, IsOptional, IsString, MinLength } from 'class-validator';

/** Payload from the mobile customer registration form. */
export class RegisterDto {
  /** Registration method — determines whether `identifier` is an email or E.164 phone. */
  @IsIn(['email', 'phone'])
  method!: 'email' | 'phone';

  /**
   * Email address (when method='email') or canonical E.164 PH mobile
   * (`+639XXXXXXXXX`, when method='phone').
   */
  @IsString()
  @IsNotEmpty()
  identifier!: string;

  @IsString()
  @MinLength(6)
  password!: string;

  @IsString()
  @IsNotEmpty()
  firstName!: string;

  @IsString()
  @IsNotEmpty()
  lastName!: string;

  @IsString()
  @IsNotEmpty()
  address!: string;

  @IsIn(['household', 'commercial'])
  accountType!: 'household' | 'commercial';

  /** Optional contact number collected at sign-up (stored in user_metadata). */
  @IsOptional()
  @IsString()
  contactNumber?: string;
}
