import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
} from 'class-validator';
import { BranchGeofence } from '../branch.entity';

/**
 * Payload from the "Register new branch account" wizard. The ValidationPipe
 * (whitelist: true) strips anything not declared here, so the service only ever
 * sees these fields (AGENTS.md §12).
 *
 * Deferred fields (curfew, low-stock threshold) are intentionally NOT accepted:
 * they have no home in core.branches yet and are dropped even if the client
 * sends them. The geofence polygon, however, IS persisted (jsonb column).
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

  // The chosen existing owner's profile id. Only sent (and only used) on the
  // "existing owner" path, where it is the integrity boundary for linking the
  // new branch onto that owner's profile. Omitted for the "new owner" path,
  // which provisions a fresh login instead.
  @IsOptional()
  @IsUUID()
  ownerId?: string;

  @IsOptional()
  @IsString()
  ownerName?: string;

  // Integrity boundary for the owner login: the "new owner" path provisions a
  // real GoTrue user from this value, so it must be a valid address. Normalized
  // (trim + lowercase) before validation so the persisted email is canonical.
  // The "existing owner" path sends a real, already-valid address too.
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  ownerEmail?: string;

  // Canonical E.164 mobile for a brand-new owner: +63 followed by the 10 PH
  // national digits (which always start with 9), e.g. +639171234567. @Matches is
  // the integrity boundary; the client's spaced display + fixed +63 prefix are
  // UX only. Existing-owner submissions omit this field.
  @IsOptional()
  @IsString()
  @Matches(/^\+639\d{9}$/, {
    message: 'ownerMobile must be a valid PH mobile number (+639XXXXXXXXX)',
  })
  ownerMobile?: string;

  // The chosen core.known_store_locations id when provisioned from a reference
  // location; omitted/null for a free-text branch. Records provenance and drives
  // duplicate detection (never name/address).
  @IsOptional()
  @IsUUID()
  sourceStoreLocationId?: string;

  // Delivery coverage polygon drawn in the wizard's Geofence step, or null/omitted
  // when none was drawn. Shape is validated on the client; stored as jsonb.
  @IsOptional()
  @IsObject()
  geofence?: BranchGeofence | null;
}
