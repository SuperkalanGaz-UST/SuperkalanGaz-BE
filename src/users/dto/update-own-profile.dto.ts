import {
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/** Personal fields an authenticated staff account may change on itself. */
export class UpdateOwnProfileDto {
  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @Matches(/^\+639\d{9}$/, { message: 'Enter a valid PH mobile number' })
  phone?: string | null;
}
