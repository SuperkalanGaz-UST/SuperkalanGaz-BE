import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { Principal, REQUEST_PRINCIPAL } from './principal';
import { SupabaseJwtService } from './supabase-jwt.service';

/**
 * Allows a signed-in mobile user to receive the least-privileged `customer`
 * claim exactly once. Staff identities already carry a different CRM role and
 * are rejected, so this endpoint cannot be used to replace staff authorization.
 */
@Injectable()
export class CustomerBootstrapGuard implements CanActivate {
  constructor(private readonly jwt: SupabaseJwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing Bearer token');
    }

    const payload = await this.jwt.verify(header.slice('Bearer '.length));
    if (typeof payload.sub !== 'string') {
      throw new UnauthorizedException('Token has no subject');
    }

    const claims = (payload.app_metadata ?? {}) as Record<string, unknown>;
    if (claims.role !== undefined && claims.role !== 'customer') {
      throw new ForbiddenException('Only customer accounts can use the mobile app');
    }
    if (claims.status !== undefined && claims.status !== 'Active') {
      throw new ForbiddenException('This account is inactive');
    }

    const principal: Principal = {
      userId: payload.sub,
      role: 'customer',
      email: typeof payload.email === 'string' ? payload.email : null,
      phone: typeof payload.phone === 'string' ? payload.phone : null,
      status: 'Active',
      branches: [],
      branchIds: [],
    };
    Object.defineProperty(request, REQUEST_PRINCIPAL, {
      value: principal,
      enumerable: true,
    });
    return true;
  }
}
