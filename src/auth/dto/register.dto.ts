import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MinLength,
} from 'class-validator';

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
  @Matches(/^(?:[^\s@]+@[^\s@]+\.[^\s@]+|\+639\d{9})$/, {
    message: 'identifier must be a valid email or canonical PH mobile number',
  })
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
  @Matches(/^\+639\d{9}$/, { message: 'Enter a valid PH mobile number' })
  contactNumber?: string;
}
