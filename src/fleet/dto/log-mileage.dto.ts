import { IsDateString, IsInt, IsOptional, Min } from 'class-validator';

/** Payload for POST /vehicles/:id/mileage (story BM-043). */
export class LogMileageDto {
  @IsInt()
  @Min(0)
  odometerKm!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  fuelLiters?: number;

  /** Defaults to the moment of submission when omitted. */
  @IsOptional()
  @IsDateString()
  loggedAt?: string;
}
