import { IsNotEmpty, IsObject, IsOptional, IsString } from 'class-validator';
import { BranchGeofence } from '../branch.entity';

/**
 * Editable fields for an existing branch (Franchise Registry "Edit" modal).
 * Every field is optional — only the keys present are updated, and the
 * ValidationPipe (whitelist: true) strips anything else. `name` and `address`
 * may be changed but not blanked; city/province/contact may be cleared.
 */
export class UpdateBranchDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsString()
  contactNumber?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  address?: string;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsString()
  province?: string;

  /**
   * Delivery coverage polygon, or null to clear it. Shape is validated on the
   * client (draw editor); stored as-is in the jsonb column.
   */
  @IsOptional()
  @IsObject()
  geofence?: BranchGeofence | null;
}
