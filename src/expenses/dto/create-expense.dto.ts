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
} from 'class-validator';
import { EXPENSE_CATEGORIES, ExpenseCategory } from '../expense-category';

/** Client fields only. branchId, recordedBy, and audit timestamps are server-owned. */
export class CreateExpenseDto {
  @IsString()
  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'expenseDate must use YYYY-MM-DD' })
  expenseDate!: string;

  @IsString()
  @IsIn([...EXPENSE_CATEGORIES])
  category!: ExpenseCategory;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(9_999_999_999.99)
  amount!: number;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  reference?: string | null;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  description!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  receiptName?: string | null;
}
