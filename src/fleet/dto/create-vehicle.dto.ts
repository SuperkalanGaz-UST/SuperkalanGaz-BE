import { Transform } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  normalizeVehicleDisplayName,
  VEHICLE_DISPLAY_NAME_MAX_LENGTH,
} from './vehicle-display-name';

/**
 * Vehicle registration input. Branch and status are intentionally absent:
 * branch scope comes from the verified JWT and every new vehicle starts active.
 */
export class CreateVehicleDto {
  @Transform(({ value }) =>
    typeof value === 'string'
      ? value.trim().toUpperCase().replace(/\s+/g, ' ')
      : value,
  )
  @IsString()
  @MinLength(2)
  @MaxLength(20)
  @Matches(/^[A-Z0-9]+(?:[ -][A-Z0-9]+)*$/, {
    message: 'plateNumber must contain only letters, numbers, spaces, or hyphens',
  })
  plateNumber!: string;

  @IsInt()
  @Min(0)
  initialOdometerKm!: number;

  /** Optional label such as "Red Yamaha Single Tank"; blank means none. */
  @Transform(({ value }) => normalizeVehicleDisplayName(value))
  @IsOptional()
  @IsString()
  @MaxLength(VEHICLE_DISPLAY_NAME_MAX_LENGTH)
  displayName?: string | null;
}
