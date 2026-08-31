import { Transform } from 'class-transformer';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

/**
 * The physical SinoTrack identifier is submitted only when the Branch Manager
 * deliberately connects hardware to an already registered branch vehicle.
 */
export class ConnectVehicleGpsDto {
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(4)
  @MaxLength(64)
  @Matches(/^[A-Za-z0-9_-]+$/, {
    message:
      'hardwareUniqueId must contain only letters, numbers, hyphens, or underscores',
  })
  hardwareUniqueId!: string;
}
