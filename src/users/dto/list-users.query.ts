import { IsIn, IsOptional, IsString } from 'class-validator';

export class ListUsersQuery {
  @IsOptional()
  @IsIn(['branch-owner', 'branch-manager'])
  role?: 'branch-owner' | 'branch-manager';

  /**
   * Convenience filter for the UI's branch switcher. This narrows results but
   * never widens them — the service re-checks it against the caller's own
   * branch scope before use.
   */
  @IsOptional()
  @IsString()
  branch?: string;
}
