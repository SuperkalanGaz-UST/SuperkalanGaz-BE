import { Type } from 'class-transformer';
import {
  IsIn,
  IsDateString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { EXPENSE_CATEGORIES, ExpenseCategory } from '../expense-category';

export class UpdateExpenseDto {
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'expenseDate must use YYYY-MM-DD' })
  expenseDate?: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @IsIn([...EXPENSE_CATEGORIES])
  category?: ExpenseCategory;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(9_999_999_999.99)
  amount?: number;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  reference?: string | null;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  receiptName?: string | null;
}
