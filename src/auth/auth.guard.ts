import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Request } from 'express';
import { In, IsNull, Repository } from 'typeorm';
import { Branch } from '../branches/branch.entity';
import { Profile } from '../users/profile.entity';
import { Principal, REQUEST_PRINCIPAL, Role } from './principal';
import { SupabaseJwtService } from './supabase-jwt.service';

/**
 * Authenticates every request: verifies the Supabase JWT, then loads the
 * caller's profiles row to build the Principal. Isolation is enforced HERE,
 * at the application layer (guards + service checks) — not by Postgres RLS
 * and not by physical partitioning (AGENTS.md §5).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly jwt: SupabaseJwtService,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
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

    // Role and branch scope come from our own DB row for this user — the
    // client never supplies them.
    const profile = await this.profiles.findOne({
      where: { id: payload.sub, deletedAt: IsNull() },
    });
    if (!profile) {
      throw new ForbiddenException('No CRM profile for this account');
    }
    if (profile.status !== 'Active') {
      throw new ForbiddenException('This account is inactive');
    }

    // Resolve the caller's branch names to their UUIDs once here, so every
    // domain service can scope by branch_id (AGENTS.md §5/§6) without repeating
    // the lookup. Only live branches count: this table soft-deletes via
    // status='inactive' (no deleted_at), so an inactive/renamed name drops out.
    const names = profile.branches ?? [];
    const liveBranches = names.length
      ? await this.branches.find({
          where: { name: In(names), status: 'active' },
          select: { id: true },
        })
      : [];

    const principal: Principal = {
      userId: profile.id,
      role: profile.role as Role,
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
