import { Transform } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

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

  @IsOptional()
  @IsUUID()
  assignedRiderId?: string;
}
