import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { Principal, REQUEST_PRINCIPAL, Role } from './principal';
import { ROLES_KEY } from './roles.decorator';

/** Enforces @Roles(...) on handlers. Runs after AuthGuard has attached the principal. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const principal = (request as unknown as Record<string, Principal | undefined>)[
      REQUEST_PRINCIPAL
    ];
    if (!principal || !required.includes(principal.role)) {
      throw new ForbiddenException('Your role cannot perform this action');
    }
    return true;
  }
}
