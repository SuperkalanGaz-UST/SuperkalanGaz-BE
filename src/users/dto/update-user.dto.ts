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

export class UpdateUserDto {
  @IsOptional()
  @IsEmail()
  email?: string;

  // L5 fix: was MinLength(6) — an admin resetting someone else's password
  // could set a weaker one than the user could set themselves.
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  username?: string;

  @IsOptional()
  @IsIn(['branch-owner', 'branch-manager'])
  role?: 'branch-owner' | 'branch-manager';

  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID(undefined, { each: true })
  branchIds?: string[];

  @IsOptional()
  @IsIn(['Active', 'Inactive'])
  status?: 'Active' | 'Inactive';
}
