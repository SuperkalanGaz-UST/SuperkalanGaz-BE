import { IsIn, IsObject, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { GOVERNANCE_REQUEST_TYPES, GovernanceRequestType, GovernanceRisk } from '../governance-request.entity';

export class CreateGovernanceRequestDto {
  @IsIn([...GOVERNANCE_REQUEST_TYPES])
  type!: GovernanceRequestType;

  @IsString()
  @MinLength(3)
  @MaxLength(120)
  title!: string;

  @IsString()
  @MinLength(5)
  @MaxLength(1000)
  reason!: string;

  @IsOptional()
  @IsIn(['low', 'medium', 'high'])
  riskLevel?: GovernanceRisk;

  @IsOptional()
  @IsUUID()
  branchId?: string;

  @IsObject()
  payload!: Record<string, unknown>;
}
