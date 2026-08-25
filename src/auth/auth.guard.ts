import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { In, Repository } from 'typeorm';
import { Branch } from '../branches/branch.entity';
import { isRole, Principal, REQUEST_PRINCIPAL } from './principal';
import { ALLOW_PENDING_INVITATION_KEY } from './roles.decorator';
import { SupabaseJwtService } from './supabase-jwt.service';

/**
 * Authenticates every request: verifies the Supabase JWT and builds the
 * Principal straight from its claims. The caller's role + branch scope live in
 * the token's `app_metadata` — set only by our service-role GoTrue calls, so the
 * client can never forge or widen them, and there is no profiles table to read.
 * Isolation is enforced HERE, at the application layer (guards + service checks)
 * — not by Postgres RLS and not by physical partitioning (AGENTS.md §5).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly jwt: SupabaseJwtService,
    private readonly reflector: Reflector,
    @InjectRepository(Branch)
    private readonly branches: Repository<Branch>,
  ) {}

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

    // Role/branch scope/status come from app_metadata — written only by our
    // service-role GoTrue calls, so the client cannot widen its own access.
    const claims = (payload.app_metadata ?? {}) as Record<string, unknown>;
    const requestPath = request.originalUrl || request.url || '';
    const isCustomerPublicBranchLookup = request.method === 'GET' && requestPath.endsWith('/api/branches/public');
    const claimedRole = typeof claims.role === 'string'
      ? claims.role
      : isCustomerPublicBranchLookup
        ? 'customer'
        : undefined;

    if (!isRole(claimedRole)) {
      console.log('[auth] denied account without CRM role', {
        requestPath,
        method: request.method,
        claims: {
          role: claims.role,
          status: claims.status,
        },
      });
      throw new ForbiddenException('No CRM role for this account');
    }
    const allowPendingInvitation =
      claims.role === 'franchise-admin' &&
      claims.status === 'Pending' &&
      this.reflector.getAllAndOverride<boolean>(ALLOW_PENDING_INVITATION_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) === true;
    if (
      claims.status !== undefined &&
      claims.status !== 'Active' &&
      !allowPendingInvitation
    ) {
      throw new ForbiddenException('This account is inactive');
    }

    const names = Array.isArray(claims.branches)
      ? (claims.branches as unknown[]).filter((b): b is string => typeof b === 'string')
      : [];

    // Resolve the caller's branch names to their core.branches UUIDs once here,
    // so every domain service can scope by branch_id (AGENTS.md §5/§6) without
    // repeating the lookup. Only live branches count: this table soft-deletes via
    // status='inactive', so an inactive/renamed name drops out and scoping fails
    // closed.
    const liveBranches = names.length
      ? await this.branches.find({
          where: { name: In(names), status: 'active' },
          select: { id: true },
        })
      : [];

    console.log('[auth] resolved principal', {
      requestPath,
      method: request.method,
      role: claimedRole,
      userId: payload.sub,
    });

    const principal: Principal = {
      userId: payload.sub,
      role: claimedRole,
      email: typeof payload.email === 'string' ? payload.email : null,
      username: typeof claims.username === 'string' ? claims.username : null,
      displayName: typeof claims.display_name === 'string' ? claims.display_name : null,
      phone: typeof claims.phone === 'string' ? claims.phone : null,
      status: allowPendingInvitation ? 'Pending' : 'Active',
      accountType:
        claims.account_type === 'household' || claims.account_type === 'commercial'
          ? claims.account_type
          : undefined,
      branches: names,
      branchIds: liveBranches.map((b) => b.id),
    };
    Object.defineProperty(request, REQUEST_PRINCIPAL, {
      value: principal,
      enumerable: true,
    });
    return true;
  }
}
