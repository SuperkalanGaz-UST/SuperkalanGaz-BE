import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { GOVERNANCE_AUDIT_CATEGORIES, GovernanceAuditCategory } from '../governance-audit-event.entity';
import { GOVERNANCE_REQUEST_TYPES, GovernanceRequestStatus, GovernanceRequestType } from '../governance-request.entity';

export class ListGovernanceRequestsQuery {
  @IsOptional()
  @IsIn([...GOVERNANCE_REQUEST_TYPES])
  type?: GovernanceRequestType;

  @IsOptional()
  @IsIn(['pending', 'applying', 'approved', 'rejected', 'revision-requested'])
  status?: GovernanceRequestStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit = 100;
}

export class ListGovernanceAuditQuery {
  @IsOptional()
  @IsIn([...GOVERNANCE_AUDIT_CATEGORIES])
  category?: GovernanceAuditCategory;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit = 200;
}
