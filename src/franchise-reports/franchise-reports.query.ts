import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

export class FranchiseReportsQuery {
  @IsOptional() @IsUUID() branchId?: string;
  @IsOptional() @IsString() @MaxLength(200) search?: string;
  @IsOptional() @IsIn(['all', 'Active', 'Reward Eligible']) status?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 10;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(5) stars?: number;
  @IsOptional() @IsIn(['all', 'open', 'in_progress', 'resolved', 'closed']) incidentStatus?: string;
}
