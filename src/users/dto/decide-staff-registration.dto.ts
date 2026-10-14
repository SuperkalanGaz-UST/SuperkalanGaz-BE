import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';

export class DecideStaffRegistrationDto {
  @IsIn(['approve', 'reject'])
  decision!: 'approve' | 'reject';

  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason!: string;
}
