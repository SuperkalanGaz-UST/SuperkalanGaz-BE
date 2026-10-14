import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';

export type GovernanceDecision = 'approve' | 'reject' | 'request-revision';

export class DecideGovernanceRequestDto {
  @IsIn(['approve', 'reject', 'request-revision'])
  decision!: GovernanceDecision;

  @IsString()
  @MinLength(5)
  @MaxLength(1000)
  reason!: string;
}
