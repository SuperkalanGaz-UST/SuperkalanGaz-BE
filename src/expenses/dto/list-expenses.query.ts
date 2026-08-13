import { IsOptional, Matches } from 'class-validator';

export class ListExpensesQuery {
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'month must use YYYY-MM' })
  month?: string;
}
