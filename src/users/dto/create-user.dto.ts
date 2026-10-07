import {
  ArrayNotEmpty,
  IsArray,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateUserDto {
  @IsEmail()
  email!: string;

  // L5 fix: was MinLength(6), weaker than the rest of the app's password rules.
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password!: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  username?: string;

  /**
   * Franchise Administrator accounts cannot be provisioned through this
   * endpoint; they require the dedicated Super Administrator invitation path.
   * BO callers are further restricted to 'branch-manager' in the service.
   */
  @IsOptional()
  @IsIn(['branch-owner', 'branch-manager'])
  role?: 'branch-owner' | 'branch-manager';

  @IsArray()
  @ArrayNotEmpty()
  @IsUUID(undefined, { each: true })
  branchIds!: string[];

  @IsOptional()
  @IsIn(['Active', 'Inactive'])
  status?: 'Active' | 'Inactive';
}
