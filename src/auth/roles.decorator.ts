import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { Request } from 'express';
import { Principal, REQUEST_PRINCIPAL, Role } from './principal';

export const ROLES_KEY = 'roles';

export const ALLOW_PENDING_INVITATION_KEY = 'allowPendingInvitation';

/** Restricts a handler to the given roles (checked by RolesGuard after AuthGuard). */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

/** Opens only the decorated handler to a role-locked pending invitation. */
export const AllowPendingInvitation = () =>
  SetMetadata(ALLOW_PENDING_INVITATION_KEY, true);

/** Injects the authenticated Principal into a handler parameter. */
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Principal => {
    const request = context.switchToHttp().getRequest<Request>();
    return (request as unknown as Record<string, Principal>)[REQUEST_PRINCIPAL];
  },
);
