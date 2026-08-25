import { IsIn, IsOptional, Matches } from 'class-validator';

export class ListStaffRegistrationsQuery {
  @IsOptional()
  @IsIn(['pending'])
  status?: 'pending';

  @IsOptional()
  @Matches(/^(branch-owner|branch-manager)(,(branch-owner|branch-manager))*$/)
  roles?: string;
}
