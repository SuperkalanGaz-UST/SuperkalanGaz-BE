import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';

/**
 * Payload from the "Register new branch account" wizard. The ValidationPipe
 * (whitelist: true) strips anything not declared here, so the service only ever
 * sees these fields (AGENTS.md §12).
 *
 * Deferred fields (geofence, curfew, low-stock threshold) are intentionally NOT
 * accepted: they have no home in core.branches yet and are dropped even if the
 * client sends them.
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

  // City is left blank-but-editable on autofill, so it is not required.
  @IsOptional()
  @IsString()
  city?: string;

  // Province is an editable default (may come from a reference autofill); one
  // reference row legitimately has no province, so it is optional.
  @IsOptional()
  @IsString()
  province?: string;

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

  // The chosen core.known_store_locations id when provisioned from a reference
  // location; omitted/null for a free-text branch. Records provenance and drives
  // duplicate detection (never name/address).
  @IsOptional()
  @IsUUID()
  sourceStoreLocationId?: string;
}
