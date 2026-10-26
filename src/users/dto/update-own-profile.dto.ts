import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

/** Personal fields an authenticated staff account may change on itself. */
export class UpdateOwnProfileDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @MinLength(3)
  @MaxLength(64)
  @Matches(/^[a-z0-9._-]+$/, {
    message: 'Use 3–64 letters, numbers, dots, underscores, or hyphens for your username',
  })
  username?: string;

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
