import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { Geofence } from '../branch.entity';

/**
 * Payload from the "Register new branch account" wizard (all four steps
 * flattened). The ValidationPipe (whitelist: true) strips anything not declared
 * here, so the service only ever sees these fields (AGENTS.md §12).
 */
export class CreateBranchDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsOptional()
  @IsString()
  contactNumber?: string;

  @IsString()
  @IsNotEmpty()
  address!: string;

  @IsString()
  @IsNotEmpty()
  city!: string;

  @IsString()
  @IsNotEmpty()
  province!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  lowStockThreshold?: number;

  @IsOptional()
  @IsIn(['existing', 'new'])
  ownerType?: 'existing' | 'new';

  @IsOptional()
  @IsString()
  ownerName?: string;

  // Kept as a plain string (not @IsEmail): the "existing owner" path sends a
  // display-derived address and we don't want to reject a demo value.
  @IsOptional()
  @IsString()
  ownerEmail?: string;

  // Contact number for a brand-new owner (already normalized to +63 form).
  @IsOptional()
  @IsString()
  ownerMobile?: string;

  @IsOptional()
  @IsObject()
  geofence?: Geofence;

  @IsOptional()
  @IsString()
  curfewStart?: string;

  @IsOptional()
  @IsString()
  curfewEnd?: string;
}
