import { Transform } from 'class-transformer';
import { IsString, MaxLength, ValidateIf } from 'class-validator';
import {
  normalizeVehicleDisplayName,
  VEHICLE_DISPLAY_NAME_MAX_LENGTH,
} from './vehicle-display-name';

/**
 * Rename (or clear) a vehicle's display label. Only the label is accepted:
 * plate, branch, status, and GPS identifiers cannot change through this DTO.
 * `null` or a blank string clears the label.
 */
export class UpdateVehicleNameDto {
  @Transform(({ value }) => normalizeVehicleDisplayName(value))
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(VEHICLE_DISPLAY_NAME_MAX_LENGTH)
  displayName!: string | null;
}
