import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Request } from 'express';
import { In, Repository } from 'typeorm';
import { Branch } from '../branches/branch.entity';
import { Principal, REQUEST_PRINCIPAL, Role } from './principal';
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
    const role = claims.role;
    if (typeof role !== 'string') {
      throw new ForbiddenException('No CRM role for this account');
    }
    if (claims.status !== undefined && claims.status !== 'Active') {
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

    const principal: Principal = {
      userId: payload.sub,
      role: role as Role,
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
