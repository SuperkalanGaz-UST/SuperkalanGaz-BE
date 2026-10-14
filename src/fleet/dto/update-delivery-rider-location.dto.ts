import { IsISO8601, IsNumber, Max, Min } from 'class-validator';

/**
 * Foreground phone position for Service Request and dispatch operations.
 * Branch and Delivery Rider identity are never accepted from the client; both
 * come from the verified JWT principal in the Fleet service.
 */
export class UpdateDeliveryRiderLocationDto {
  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(-90)
  @Max(90)
  latitude!: number;

  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(-180)
  @Max(180)
  longitude!: number;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(10_000)
  accuracyM!: number;

  @IsISO8601({ strict: true })
  capturedAt!: string;
}
