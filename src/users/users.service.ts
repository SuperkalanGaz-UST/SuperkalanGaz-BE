import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Principal } from '../auth/principal';
import { CreateUserDto } from './dto/create-user.dto';
import { ListUsersQuery } from './dto/list-users.query';
import { UpdateUserDto } from './dto/update-user.dto';
import { GoTrueAdminService, GoTrueUser } from './gotrue-admin.service';

/** A staff account as the CRM sees it, projected from auth.users app_metadata. */
export interface CrmUser {
  id: string;
  email: string | null;
  username: string | null;
  displayName: string | null;
  role: string;
  branches: string[];
  phone: string | null;
  status: 'Active' | 'Inactive';
  createdAt: Date;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** True once a user has been soft-deleted (banned into the future). */
function isBanned(u: GoTrueUser): boolean {
  return !!u.banned_until && new Date(u.banned_until).getTime() > Date.now();
}

/** Projects a GoTrue user into the CRM shape, reading claims from app_metadata. */
function toCrmUser(u: GoTrueUser): CrmUser {
  const m = u.app_metadata ?? {};
  return {
    id: u.id,
    email: u.email,
    username: str(m.username),
    displayName: str(m.display_name),
    role: str(m.role) ?? '',
    branches: strArray(m.branches),
    phone: str(m.phone),
    status: m.status === 'Inactive' ? 'Inactive' : 'Active',
    createdAt: new Date(u.created_at),
  };
}

/**
 * Staff-account management (FA: branch accounts; BO: Branch Manager accounts for
 * their own branch). Identity lives entirely in Supabase Auth: there is no
 * public.profiles table, so every read/write goes through the GoTrue Admin API
 * and CRM claims live in each user's app_metadata (AGENTS.md §5, §6). All scoping
 * derives from the verified Principal — request params can only NARROW
 * visibility, never widen it. Isolation is guard/service-enforced here.
 */
@Injectable()
export class UsersService {
  constructor(private readonly goTrue: GoTrueAdminService) {}

  /**
   * The caller's own account. The AuthGuard has already verified this user is
   * active, so a missing/banned record here would be a real anomaly.
   */
  async findById(id: string): Promise<CrmUser> {
    const user = await this.goTrue.getUser(id);
    if (!user || isBanned(user)) throw new NotFoundException('User not found');
    return toCrmUser(user);
  }

  async list(principal: Principal, query: ListUsersQuery): Promise<CrmUser[]> {
    // Validate the requested branch scope once, up front (a BO cannot list
    // outside their own branches), before we fan out over the user set.
    if (query.branch) this.assertBranchInScope(principal, query.branch);

    // BO may only ever see Branch Manager accounts, whatever the query says.
    const role = principal.role === 'branch-owner' ? 'branch-manager' : query.role;

    // A BO with no branch requested and no branches of their own overlaps nobody.
    if (!query.branch && principal.role === 'branch-owner' && principal.branches.length === 0) {
      return [];
    }

    const users = (await this.goTrue.listUsers())
      .filter((u) => !isBanned(u)) // soft-deleted accounts drop out of the list
      .map(toCrmUser)
      .filter((u) => {
        if (role && u.role !== role) return false;
        if (query.branch) return u.branches.includes(query.branch);
        // No branch requested: a BO still only sees users overlapping their own.
        if (principal.role === 'branch-owner') {
          return u.branches.some((b) => principal.branches.includes(b));
        }
        return true;
      });

    return users.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async create(principal: Principal, dto: CreateUserDto): Promise<{ id: string }> {
    const role = dto.role ?? 'branch-manager';
    if (principal.role === 'branch-owner' && role !== 'branch-manager') {
      throw new ForbiddenException('Branch Owners may only create Branch Manager accounts');
    }
    for (const branch of dto.branches) {
      this.assertBranchInScope(principal, branch);
    }

    // Identity AND CRM claims both live in Supabase Auth. The claims go in
    // app_metadata — service-role-only, so a user can never edit their own role
    // or branch scope (AGENTS.md §5).
    return this.goTrue.createUser({
      email: dto.email,
      password: dto.password,
      email_confirm: true,
      app_metadata: {
        username: dto.username ?? dto.email.split('@')[0],
        display_name: dto.name ?? null,
        role,
        branches: dto.branches,
        phone: dto.phone ?? null,
        status: dto.status ?? 'Active',
      },
    });
  }

  async update(principal: Principal, id: string, dto: UpdateUserDto): Promise<void> {
    const target = await this.findManageable(principal, id);

    if (dto.role && dto.role !== target.role && principal.role === 'branch-owner') {
      throw new ForbiddenException('Branch Owners cannot change account roles');
    }
    if (dto.branches) {
      for (const branch of dto.branches) {
        this.assertBranchInScope(principal, branch);
      }
    }

    // Auth-owned fields go through the Admin API's first-class columns…
    if (dto.email || dto.password) {
      await this.goTrue.updateUser(id, {
        ...(dto.email ? { email: dto.email } : {}),
        ...(dto.password ? { password: dto.password } : {}),
      });
    }

    // …CRM claims are patched onto app_metadata. We re-send the full claim set
    // (current values overlaid with the change) so the write is robust whether
    // GoTrue merges or replaces app_metadata.
    const next: Record<string, unknown> = {
      username: target.username,
      display_name: target.displayName,
      role: target.role,
      branches: target.branches,
      phone: target.phone,
      status: target.status,
    };
    if (dto.username !== undefined) next.username = dto.username;
    if (dto.name !== undefined) next.display_name = dto.name;
    if (dto.role !== undefined) next.role = dto.role;
    if (dto.branches !== undefined) next.branches = dto.branches;
    if (dto.phone !== undefined) next.phone = dto.phone;
    if (dto.status !== undefined) next.status = dto.status;

    await this.goTrue.updateUser(id, { app_metadata: next });
  }

  /**
   * Soft delete only (AGENTS.md §3.2): ban the auth user so they can no longer
   * sign in, and flip the status claim inactive. The auth.users row is retained
   * for audit/history; nothing is ever hard-deleted.
   */
  async softDelete(principal: Principal, id: string): Promise<void> {
    const target = await this.findManageable(principal, id);

    await this.goTrue.banUser(id);
    await this.goTrue.updateUser(id, {
      app_metadata: {
        username: target.username,
        display_name: target.displayName,
        role: target.role,
        branches: target.branches,
        phone: target.phone,
        status: 'Inactive',
      },
    });
  }

  /**
   * Loads a target account and verifies the caller may manage it. Referential
   * integrity is checked here in the service layer (AGENTS.md §6). Out-of-scope
   * targets return 404 rather than 403 so a BO cannot probe for accounts in
   * other branches.
   */
  private async findManageable(principal: Principal, id: string): Promise<CrmUser> {
    const user = await this.goTrue.getUser(id);
    if (!user || isBanned(user)) throw new NotFoundException('User not found');
    const target = toCrmUser(user);

    if (target.role === 'franchise-admin') {
      throw new ForbiddenException('Franchise Administrator accounts cannot be managed here');
    }

    if (principal.role === 'branch-owner') {
      const overlaps = target.branches.some((b) => principal.branches.includes(b));
      if (target.role !== 'branch-manager' || !overlaps) {
        throw new NotFoundException('User not found');
      }
    }
    return target;
  }

  /** A caller may only touch branches inside their own scope. FA is cross-branch. */
  private assertBranchInScope(principal: Principal, branch: string): void {
    if (principal.role === 'franchise-admin') return;
    if (!principal.branches.includes(branch)) {
      throw new ForbiddenException(`You have no access to ${branch}`);
    }
  }
}
