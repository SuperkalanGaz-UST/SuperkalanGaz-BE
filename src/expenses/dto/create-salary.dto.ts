import { Type } from 'class-transformer';
import {
  IsDateString,
  IsNumber,
  IsUUID,
  Matches,
  Max,
  Min,
} from 'class-validator';

export class CreateSalaryDto {
  @IsUUID()
  branchId!: string;

  @IsUUID()
  staffId!: string;

  /** A retry of the same entry must not record a second expense. */
  @IsUUID()
  requestId!: string;

  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  periodStart!: string;

  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  periodEnd!: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100_000)
  regularHours!: number;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(1_000_000)
  hourlyRate!: number;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100_000)
  overtimeHours!: number;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1_000_000)
  overtimeHourlyRate!: number;
}
