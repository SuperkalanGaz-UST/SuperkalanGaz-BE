import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Request } from 'express';
import { IsNull, Repository } from 'typeorm';
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

    const principal: Principal = {
      userId: profile.id,
      role: profile.role as Role,
      branches: profile.branches ?? [],
    };
    Object.defineProperty(request, REQUEST_PRINCIPAL, {
      value: principal,
      enumerable: true,
    });
    return true;
  }
}
