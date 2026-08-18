import { IsIn, IsNotEmpty, IsString, Matches } from 'class-validator';

/** Identifies the pending signup that should receive a replacement OTP. */
export class ResendSignUpCodeDto {
  @IsIn(['email', 'phone'])
  method!: 'email' | 'phone';

  @IsString()
  @IsNotEmpty()
  @Matches(/^(?:[^\s@]+@[^\s@]+\.[^\s@]+|\+639\d{9})$/, {
    message: 'identifier must be a valid email or canonical PH mobile number',
  })
  identifier!: string;
}
