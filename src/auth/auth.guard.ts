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
import {
  hasMetadataBranchIds,
  metadataBranchIds,
  metadataBranchNames,
} from './branch-scope';
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
      (claims.role === 'franchise-admin' || claims.role === 'driver') &&
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

    const claimedBranchIds = metadataBranchIds(claims);
    const legacyBranchNames = metadataBranchNames(claims);
    const hasUuidScopeClaim = hasMetadataBranchIds(claims);

    // UUIDs are the authorization claim. The name lookup is a rollout-only
    // compatibility path for sessions created before branch_ids was introduced;
    // it is ignored as soon as a UUID claim is present, so stale display labels
    // can never widen an already migrated account.
    const liveBranches = hasUuidScopeClaim
      ? claimedBranchIds.length
        ? await this.branches.find({
            where: { id: In(claimedBranchIds), status: 'active' },
            select: { id: true, name: true, ownerId: true },
          })
        : []
      : legacyBranchNames.length
        ? await this.branches.find({
            where: { name: In(legacyBranchNames), status: 'active' },
            select: { id: true, name: true, ownerId: true },
          })
        : [];

    const liveById = new Map(liveBranches.map((branch) => [branch.id, branch]));
    const liveByName = new Map<string, Branch[]>();
    for (const branch of liveBranches) {
      liveByName.set(branch.name, [...(liveByName.get(branch.name) ?? []), branch]);
    }
    const claimedLiveBranches = hasUuidScopeClaim
      ? claimedBranchIds.flatMap((id) => {
          const branch = liveById.get(id);
          return branch ? [branch] : [];
        })
      : legacyBranchNames.flatMap((name) => {
          const matches = liveByName.get(name) ?? [];
          return matches.length === 1 ? matches : [];
        });

    // For migrated Branch Owners, intersect the protected UUID claim with the
    // canonical branch row. This blocks a reassigned branch immediately even if
    // an older access token still contains its UUID. The legacy name path stays
    // available only long enough to run the documented UUID backfill.
    const orderedBranches =
      claimedRole === 'branch-owner' && hasUuidScopeClaim
        ? claimedLiveBranches.filter((branch) => branch.ownerId === payload.sub)
        : claimedLiveBranches;

    if (claimedRole === 'branch-manager' && orderedBranches.length !== 1) {
      throw new ForbiddenException('Branch Manager must have exactly one active branch');
    }

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
      branches: orderedBranches.map((branch) => branch.name),
      branchIds: orderedBranches.map((branch) => branch.id),
    };
    Object.defineProperty(request, REQUEST_PRINCIPAL, {
      value: principal,
      enumerable: true,
    });
    return true;
  }
}
