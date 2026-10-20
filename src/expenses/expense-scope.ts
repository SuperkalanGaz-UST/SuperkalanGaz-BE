import { ForbiddenException } from '@nestjs/common';
import { Principal } from '../auth/principal';

/** AuthGuard has intersected protected UUID claims with live branch ownership. */
export function expenseBranch(principal: Principal, selected?: string): string {
  if (!['branch-owner', 'branch-manager'].includes(principal.role)) {
    throw new ForbiddenException('Your role cannot access branch expenses');
  }
  if (principal.role === 'branch-manager' && principal.branchIds.length !== 1) {
    throw new ForbiddenException('Branch Manager must have one active branch');
  }
  if (selected) {
    if (!principal.branchIds.includes(selected))
      throw new ForbiddenException('Branch is outside your scope');
    return selected;
  }
  if (principal.branchIds.length !== 1) {
    throw new ForbiddenException('Select an authorized active branch');
  }
  return principal.branchIds[0];
}
