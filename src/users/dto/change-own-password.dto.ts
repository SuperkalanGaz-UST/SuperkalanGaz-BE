import { IsString, MaxLength, MinLength } from 'class-validator';

/** Password changes are isolated from profile edits so credentials are never echoed back. */
export class ChangeOwnPasswordDto {
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password!: string;
}
