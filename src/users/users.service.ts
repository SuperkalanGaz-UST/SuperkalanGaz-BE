import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { Principal } from '../auth/principal';
import { CreateUserDto } from './dto/create-user.dto';
import { ListUsersQuery } from './dto/list-users.query';
import { UpdateUserDto } from './dto/update-user.dto';
import { GoTrueAdminService } from './gotrue-admin.service';
import { Profile } from './profile.entity';

/**
 * Staff-account management (FA: branch accounts; BO: Branch Manager accounts
 * for their own branch). All scoping derives from the verified Principal —
 * request params can only NARROW visibility, never widen it (AGENTS.md §5).
 * Isolation is guard/service-enforced at this application layer, not by the DB.
 */
@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    private readonly goTrue: GoTrueAdminService,
  ) {}

  async list(principal: Principal, query: ListUsersQuery): Promise<Profile[]> {
    const qb = this.profiles
      .createQueryBuilder('p')
      .where('p.deleted_at IS NULL')
      .orderBy('p.created_at', 'ASC');

    // BO may only ever see Branch Manager accounts, whatever the query says.
    const role = principal.role === 'branch-owner' ? 'branch-manager' : query.role;
    if (role) qb.andWhere('p.role = :role', { role });

    if (query.branch) {
      this.assertBranchInScope(principal, query.branch);
      qb.andWhere('p.branches @> ARRAY[:branch]::text[]', { branch: query.branch });
    } else if (principal.role === 'branch-owner') {
      // No branch requested: BO still only sees users overlapping their own branches.
      if (principal.branches.length === 0) return [];
      qb.andWhere('p.branches && :callerBranches::text[]', {
        callerBranches: principal.branches,
      });
    }

    return qb.getMany();
  }

  async create(principal: Principal, dto: CreateUserDto): Promise<{ id: string }> {
    const role = dto.role ?? 'branch-manager';
    if (principal.role === 'branch-owner' && role !== 'branch-manager') {
      throw new ForbiddenException('Branch Owners may only create Branch Manager accounts');
    }
    for (const branch of dto.branches) {
      this.assertBranchInScope(principal, branch);
    }

    // Identity is created in Supabase Auth; the on_auth_user_created trigger
    // mirrors these claims into public.profiles.
    return this.goTrue.createUser({
      email: dto.email,
      password: dto.password,
      email_confirm: true,
      user_metadata: {
        username: dto.username,
        display_name: dto.name,
        role,
        branches: dto.branches,
        phone: dto.phone,
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

    // Auth-owned fields go through the Auth Admin API…
    if (dto.email || dto.password) {
      await this.goTrue.updateUser(id, {
        ...(dto.email ? { email: dto.email } : {}),
        ...(dto.password ? { password: dto.password } : {}),
      });
    }

    // …CRM claims are ours, updated directly on the profile row.
    const patch: Partial<Profile> = { updatedAt: new Date() };
    if (dto.email !== undefined) patch.email = dto.email;
    if (dto.name !== undefined) patch.displayName = dto.name;
    if (dto.phone !== undefined) patch.phone = dto.phone;
    if (dto.username !== undefined) patch.username = dto.username;
    if (dto.role !== undefined) patch.role = dto.role;
    if (dto.branches !== undefined) patch.branches = dto.branches;
    if (dto.status !== undefined) patch.status = dto.status;
    await this.profiles.update({ id }, patch);
  }

  /**
   * Soft delete only (AGENTS.md §3.2): mark the profile deleted and ban the
   * auth user so they can no longer sign in. The row is retained for
   * audit/history; nothing is ever hard-deleted.
   */
  async softDelete(principal: Principal, id: string): Promise<void> {
    await this.findManageable(principal, id);

    await this.goTrue.banUser(id);
    await this.profiles.update(
      { id },
      { deletedAt: new Date(), status: 'Inactive', updatedAt: new Date() },
    );
  }

  /**
   * Loads a target account and verifies the caller may manage it. Referential
   * integrity is checked here in the service layer — the schema has no FK
   * constraints by design (AGENTS.md §6). Out-of-scope targets return 404
   * rather than 403 so a BO cannot probe for accounts in other branches.
   */
  private async findManageable(principal: Principal, id: string): Promise<Profile> {
    const target = await this.profiles.findOne({ where: { id, deletedAt: IsNull() } });
    if (!target) throw new NotFoundException('User not found');

    if (target.role === 'franchise-admin') {
      throw new ForbiddenException('Franchise Administrator accounts cannot be managed here');
    }

    if (principal.role === 'branch-owner') {
      const overlaps = target.branches?.some((b) => principal.branches.includes(b));
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
