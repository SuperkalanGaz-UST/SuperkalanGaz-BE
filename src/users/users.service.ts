import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  hasMetadataBranchIds,
  metadataBranchIds,
  metadataBranchNames,
  withBranchScope,
} from '../auth/branch-scope';
import { Principal } from '../auth/principal';
import { Branch } from '../branches/branch.entity';
import { GovernanceAuditService } from '../governance/governance-audit.service';
import { CreateUserDto } from './dto/create-user.dto';
import { ListUsersQuery } from './dto/list-users.query';
import { UpdateOwnProfileDto } from './dto/update-own-profile.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { GoTrueAdminService, GoTrueUser } from './gotrue-admin.service';

/** A staff account as the CRM sees it, projected from auth.users app_metadata. */
export interface CrmUser {
  id: string;
  email: string | null;
  username: string | null;
  displayName: string | null;
  role: string;
  branchIds: string[];
  branches: string[];
  phone: string | null;
  status: 'Active' | 'Inactive' | 'Pending';
  createdAt: Date;
  lastLoginAt: Date | null;
  pendingManagerInvitation: boolean;
}

/** Current-user projection available directly from the already verified JWT. */
export type OwnProfile = Omit<CrmUser, 'createdAt' | 'lastLoginAt' | 'pendingManagerInvitation'>;

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/** True once a user has been soft-deleted (banned into the future). */
function isBanned(u: GoTrueUser): boolean {
  return !!u.banned_until && new Date(u.banned_until).getTime() > Date.now();
}

interface BranchDirectory {
  byId: Map<string, Branch>;
  byName: Map<string, Branch[]>;
}

/** Projects protected UUID scope to user-facing branch labels. */
function toCrmUser(u: GoTrueUser, directory: BranchDirectory): CrmUser {
  const m = u.app_metadata ?? {};
  const claimedIds = metadataBranchIds(m);
  const legacyNames = metadataBranchNames(m);
  const scope = hasMetadataBranchIds(m)
    ? claimedIds.flatMap((id) => {
        const branch = directory.byId.get(id);
        return branch ? [branch] : [];
      })
    : legacyNames.flatMap((name) => {
        const matches = directory.byName.get(name) ?? [];
        return matches.length === 1 ? matches : [];
      });
  return {
    id: u.id,
    email: u.email,
    username: str(m.username),
    displayName: str(m.display_name),
    role: str(m.role) ?? '',
    branchIds: scope.map((branch) => branch.id),
    branches: scope.map((branch) => branch.name),
    phone: str(m.phone),
    status: m.status === 'Pending' ? 'Pending' : m.status === 'Inactive' ? 'Inactive' : 'Active',
    createdAt: new Date(u.created_at),
    pendingManagerInvitation: m.role === 'branch-manager' && m.status === 'Pending' && m.branch_manager_invitation === true,
    lastLoginAt: m.status !== 'Pending' && u.last_sign_in_at ? new Date(u.last_sign_in_at) : null,
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
  constructor(
    private readonly goTrue: GoTrueAdminService,
    @InjectRepository(Branch)
    private readonly branchRepository: Repository<Branch>,
    private readonly audit: GovernanceAuditService,
    private readonly config: ConfigService,
  ) {}

  /**
   * The caller's own account. The AuthGuard has already verified this user is
   * active, so a missing/banned record here would be a real anomaly.
   */
  async findById(id: string): Promise<CrmUser> {
    const user = await this.goTrue.getUser(id);
    if (!user || isBanned(user)) throw new NotFoundException('User not found');
    return toCrmUser(user, await this.branchDirectory());
  }

  private ownProfileFromPrincipal(principal: Principal): OwnProfile {
    return {
      id: principal.userId,
      email: principal.email ?? null,
      username: principal.username ?? null,
      displayName: principal.displayName ?? null,
      role: principal.role,
      branchIds: principal.branchIds,
      branches: principal.branches,
      phone: principal.phone ?? null,
      // Pending principals are admitted only to the dedicated invitation
      // acceptance handler, never to this active-account profile path.
      status: principal.status === 'Inactive' ? 'Inactive' : 'Active',
    };
  }

  /**
   * Updates only the authenticated caller's personal fields. Trusted tenancy
   * claims are copied from the existing record and cannot be supplied by the
   * client, so a profile edit cannot widen role or branch access.
   */
  async updateOwnProfile(
    principal: Principal,
    dto: UpdateOwnProfileDto,
  ): Promise<OwnProfile> {
    const target = this.ownProfileFromPrincipal(principal);
    if (dto.username !== undefined) {
      const username = dto.username.trim().toLowerCase();
      const users = await this.goTrue.listUsers();
      if (users.some((user) =>
        user.id !== principal.userId &&
        typeof user.app_metadata.username === 'string' &&
        user.app_metadata.username.trim().toLowerCase() === username,
      )) {
        throw new ConflictException('This username is already in use. Choose another username.');
      }
      dto.username = username;
    }
    // Only self-service fields go in this write. role/branch_ids/branches/status
    // must NEVER be re-derived from the token and written back here: the token
    // can be stale (issued before an admin demoted/deactivated this user), and
    // doing so would silently resurrect revoked access on every profile save
    // (H1 fix — this endpoint is reachable by every role on every save).
    const nextMetadata: Record<string, unknown> = {
      ...(dto.username !== undefined ? { username: dto.username } : {}),
      ...(dto.name !== undefined ? { display_name: dto.name } : {}),
      ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
    };

    await this.goTrue.updateUser(principal.userId, {
      ...(dto.email ? { email: dto.email } : {}),
      app_metadata: nextMetadata,
    });

    return {
      ...target,
      username: dto.username ?? target.username,
      email: dto.email ?? target.email,
      displayName: dto.name ?? target.displayName,
      phone: dto.phone !== undefined ? dto.phone : target.phone,
    };
  }

  /** Changes only the authenticated caller's credential; no CRM claims move. */
  async changeOwnPassword(principal: Principal, password: string): Promise<void> {
    await this.goTrue.updateUser(principal.userId, { password });
  }

  async list(principal: Principal, query: ListUsersQuery): Promise<CrmUser[]> {
    // Validate the requested branch scope once, up front (a BO cannot list
    // outside their own branches), before we fan out over the user set.
    if (query.branchId) this.assertBranchInScope(principal, query.branchId);

    // BO may only ever see Branch Manager accounts, whatever the query says.
    const role = principal.role === 'branch-owner' ? 'branch-manager' : query.role;

    // A BO with no branch requested and no branches of their own overlaps nobody.
    if (
      !query.branchId &&
      principal.role === 'branch-owner' &&
      principal.branchIds.length === 0
    ) {
      return [];
    }

    const directory = await this.branchDirectory();
    const users = (await this.goTrue.listUsers())
      .filter((u) => !isBanned(u)) // soft-deleted accounts drop out of the list
      .map((user) => toCrmUser(user, directory))
      // This module is the staff-account directory. Customer identities are
      // managed through CIM and must never appear as branch account records.
      .filter((u) => u.role !== 'customer' && u.role !== 'super-admin')
      .filter((u) => {
        if (role && u.role !== role) return false;
        if (query.branchId) return u.branchIds.includes(query.branchId);
        // No branch requested: a BO still only sees users overlapping their own.
        if (principal.role === 'branch-owner') {
          return u.branchIds.some((id) => principal.branchIds.includes(id));
        }
        return true;
      });

    return users.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async create(principal: Principal, dto: CreateUserDto): Promise<{ id: string }> {
    const [branchId] = dto.branchIds;
    if (!branchId || dto.branchIds.length !== 1) {
      throw new BadRequestException('A Branch Manager must be assigned to exactly one branch');
    }
    this.assertBranchInScope(principal, branchId);
    const email = dto.email.trim().toLowerCase();
    const name = dto.name.trim();

    return this.branchRepository.manager.transaction(async (manager) => {
      const branch = await manager.findOne(Branch, {
        where: {
          id: branchId, status: 'active',
          ...(principal.role === 'branch-owner' ? { ownerId: principal.userId } : {}),
        },
        lock: { mode: 'pessimistic_write' },
      });
      if (!branch) throw new ForbiddenException('The selected branch is unavailable');
      // Supabase can resend an invitation to an unconfirmed address. Serialize
      // manager invitations across branches so two sends cannot claim one identity.
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
        'branch-manager-invitation', email,
      ]);
      if (await this.goTrue.findByEmail(email)) throw new ConflictException('Email already in use');

      const invited = await this.goTrue.inviteUser(email, name, this.managerInvitationRedirect());
      if (invited.app_metadata?.role) throw new ConflictException('Email already in use');
      const sentAt = invited.confirmation_sent_at ?? invited.invited_at ?? new Date().toISOString();
      const expiresAt = this.managerInvitationExpiry(sentAt);
      try {
        await this.audit.record({
          category: 'admin-account', action: 'branch-manager-invitation-sent',
          actor: principal, affectedRecordType: 'user', affectedRecordId: invited.id, branchId,
          afterState: { status: 'Pending', email, expiresAt },
        }, manager);
        await this.goTrue.updateUser(invited.id, {
          app_metadata: {
            ...withBranchScope(invited.app_metadata, [branch]),
            role: 'branch-manager', status: 'Pending', display_name: name,
            username: dto.username?.trim() || email.split('@')[0], phone: dto.phone ?? null,
            branch_manager_invitation: true, invitation_email: email, invited_by: principal.userId,
            invited_at: sentAt, invitation_expires_at: expiresAt,
          },
        });
      } catch (error) {
        await this.goTrue.banUser(invited.id).catch(() => undefined);
        throw error;
      }
      return { id: invited.id };
    });
  }

  async resendManagerInvitation(principal: Principal, id: string, branchId: string): Promise<void> {
    this.assertBranchInScope(principal, branchId);
    await this.branchRepository.manager.transaction(async (manager) => {
      const branch = await manager.findOne(Branch, {
        where: {
          id: branchId, status: 'active',
          ...(principal.role === 'branch-owner' ? { ownerId: principal.userId } : {}),
        },
        lock: { mode: 'pessimistic_write' },
      });
      if (!branch) throw new NotFoundException('Branch Manager invitation not found');

      const current = await this.goTrue.getUser(id);
      if (!current || !this.matchesManagerInvitation(current, branchId) || isBanned(current) ||
          current.app_metadata.status !== 'Pending' || !current.email) {
        throw new NotFoundException('Pending Branch Manager invitation not found');
      }

      const redirect = this.managerInvitationRedirect();
      if (current.email_confirmed_at) {
        await this.goTrue.sendExistingUserLink(current.email, redirect);
      } else {
        await this.goTrue.inviteUser(current.email, str(current.app_metadata.display_name) ?? current.email, redirect);
      }
      const expiresAt = this.managerInvitationExpiry(new Date().toISOString());
      await this.audit.record({
        category: 'admin-account', action: 'branch-manager-invitation-resent',
        actor: principal, affectedRecordType: 'user', affectedRecordId: id, branchId,
        afterState: { status: 'Pending', expiresAt },
      }, manager);
      await this.goTrue.updateUser(id, { app_metadata: { invitation_expires_at: expiresAt } });
    });
  }

  async acceptManagerInvitation(principal: Principal, password: string): Promise<void> {
    const [branchId] = principal.branchIds;
    if (!branchId || principal.branchIds.length !== 1) {
      throw new ForbiddenException('This Branch Manager invitation is not valid');
    }
    await this.branchRepository.manager.transaction(async (manager) => {
      const branch = await manager.findOne(Branch, {
        where: { id: branchId, status: 'active' },
        lock: { mode: 'pessimistic_write' },
      });
      const current = await this.goTrue.getUser(principal.userId);
      if (!branch || !current || !this.matchesManagerInvitation(current, branchId) ||
          isBanned(current) || !current.email_confirmed_at ||
          current.email?.toLowerCase() !== principal.email?.toLowerCase()) {
        throw new ForbiddenException('This Branch Manager invitation is not valid');
      }

      const metadata = current.app_metadata;
      // An already accepted invitation must never replace the password on retry.
      if (metadata.status === 'Active' && typeof metadata.invitation_accepted_at === 'string') return;
      const expires = Date.parse(String(metadata.invitation_expires_at));
      if (metadata.status !== 'Pending' || !Number.isFinite(expires) || expires <= Date.now()) {
        throw new ForbiddenException('This invitation is inactive or expired. Ask your Branch Owner to resend it.');
      }
      await this.goTrue.updateUser(current.id, {
        password,
        app_metadata: { status: 'Active', invitation_accepted_at: new Date().toISOString() },
      });
    });
  }

  private matchesManagerInvitation(user: GoTrueUser, branchId: string): boolean {
    const metadata = user.app_metadata;
    const scope = metadataBranchIds(metadata);
    return metadata.role === 'branch-manager' && metadata.branch_manager_invitation === true &&
      scope.length === 1 && scope[0] === branchId &&
      typeof metadata.invitation_email === 'string' && metadata.invitation_email === user.email?.toLowerCase();
  }

  private managerInvitationRedirect(): string {
    const origin = (this.config.get<string>('WEB_ORIGIN') ?? 'http://localhost:3000')
      .split(',')[0].trim().replace(/\/$/, '');
    return `${origin}/?invitation=branch-manager`;
  }

  private managerInvitationExpiry(sentAt: string): string {
    const configured = Number(this.config.get<string>('SUPABASE_EMAIL_OTP_EXPIRY_SECONDS') ?? '3600');
    const seconds = Number.isFinite(configured) && configured > 0 ? configured : 3600;
    return new Date(Date.parse(sentAt) + seconds * 1000).toISOString();
  }

  async update(principal: Principal, id: string, dto: UpdateUserDto): Promise<void> {
    const target = await this.findManageable(principal, id);
    if (target.status === 'Pending') {
      throw new ForbiddenException('Complete or resend the pending invitation before editing this account');
    }

    // Assigning or removing an existing Branch Owner changes branch governance.
    // It must pass through the Super Administrator queue so the old/new owner,
    // reason, reviewer, and timestamp are captured in one immutable audit event.
    const changesBranchOwnerAssignment =
      (target.role === 'branch-owner' && dto.branchIds !== undefined) ||
      (dto.role !== undefined && dto.role !== target.role &&
        (dto.role === 'branch-owner' || target.role === 'branch-owner'));
    if (changesBranchOwnerAssignment) {
      throw new ForbiddenException(
        'Branch Owner assignment changes require Super Administrator approval',
      );
    }

    if (dto.role && dto.role !== target.role && principal.role === 'branch-owner') {
      throw new ForbiddenException('Branch Owners cannot change account roles');
    }
    const resultingRole = dto.role ?? target.role;
    const resultingBranchIds = dto.branchIds ?? target.branchIds;
    if (resultingRole === 'branch-manager' && new Set(resultingBranchIds).size !== 1) {
      throw new BadRequestException('A Branch Manager must be assigned to exactly one branch');
    }
    const requestedBranches = dto.branchIds
      ? await this.resolveRequestedBranches(principal, dto.branchIds)
      : null;

    // Auth-owned fields go through the Admin API's first-class columns…
    if (dto.email || dto.password) {
      await this.goTrue.updateUser(id, {
        ...(dto.email ? { email: dto.email } : {}),
        ...(dto.password ? { password: dto.password } : {}),
      });
      // M1 fix: a password/email reset here is a silent account takeover path
      // (no re-auth, no notification) unless it lands in the immutable audit
      // trail. Never record the password itself — only that it changed.
      await this.audit.record({
        category: 'admin-account',
        action: 'admin-credential-change',
        actor: principal,
        affectedRecordType: 'user',
        affectedRecordId: id,
        afterState: {
          passwordReset: !!dto.password,
          ...(dto.email ? { emailChangedTo: dto.email } : {}),
        },
      });
    }

    // …CRM claims are patched onto app_metadata. We re-send the full claim set
    // (current values overlaid with the change) so the write is robust whether
    // GoTrue merges or replaces app_metadata.
    const next: Record<string, unknown> = {
      username: target.username,
      display_name: target.displayName,
      role: target.role,
      branch_ids: target.branchIds,
      branches: target.branches,
      phone: target.phone,
      status: target.status,
    };
    if (dto.username !== undefined) next.username = dto.username;
    if (dto.name !== undefined) next.display_name = dto.name;
    if (dto.role !== undefined) next.role = dto.role;
    if (requestedBranches) Object.assign(next, withBranchScope(next, requestedBranches));
    if (dto.phone !== undefined) next.phone = dto.phone;
    if (dto.status !== undefined) next.status = dto.status;

    await this.goTrue.updateUser(id, { app_metadata: next });
  }

  /**
   * Soft delete only (AGENTS.md §3.2): ban the auth user so they can no longer
   * sign in, and flip the status claim inactive. The auth.users row is retained
   * for audit/history; nothing is ever hard-deleted.
   */
  async softDelete(principal: Principal, id: string, branchId?: string): Promise<void> {
    const target = await this.findManageable(principal, id);
    if (branchId || target.pendingManagerInvitation) {
      if (!branchId || !target.pendingManagerInvitation ||
          !target.branchIds.includes(branchId)) {
        throw new ConflictException('The invitation has changed. Refresh and try again.');
      }
      this.assertBranchInScope(principal, branchId);
      // Keep revocation and activation mutually exclusive.
      await this.branchRepository.manager.transaction(async (manager) => {
        const branch = await manager.findOne(Branch, {
          where: {
            id: branchId, status: 'active',
            ...(principal.role === 'branch-owner' ? { ownerId: principal.userId } : {}),
          },
          lock: { mode: 'pessimistic_write' },
        });
        const current = await this.goTrue.getUser(id);
        if (!branch || !current || !this.matchesManagerInvitation(current, branchId) ||
            current.app_metadata.status !== 'Pending') {
          throw new ConflictException('The invitation has changed. Refresh and try again.');
        }
        await this.audit.record({
          category: 'admin-account', action: 'branch-manager-invitation-revoked',
          actor: principal, affectedRecordType: 'user', affectedRecordId: id, branchId,
          beforeState: { status: 'Pending' }, afterState: { status: 'Inactive' },
        }, manager);
        await this.goTrue.updateUser(id, {
          ban_duration: '876000h',
          app_metadata: { status: 'Inactive' },
        });
      });
      return;
    }

    await this.goTrue.banUser(id);
    await this.goTrue.updateUser(id, {
      app_metadata: {
        username: target.username,
        display_name: target.displayName,
        role: target.role,
        branch_ids: target.branchIds,
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
    const target = toCrmUser(user, await this.branchDirectory());

    if (target.role === 'customer') {
      throw new NotFoundException('User not found');
    }

    if (target.role === 'franchise-admin' || target.role === 'super-admin') {
      throw new ForbiddenException('Governance accounts cannot be managed here');
    }

    if (principal.role === 'branch-owner') {
      const overlaps = target.branchIds.some((id) => principal.branchIds.includes(id));
      if (target.role !== 'branch-manager' || !overlaps) {
        throw new NotFoundException('User not found');
      }
    }
    return target;
  }

  /** A caller may only touch branches inside their own scope. FA/SA are cross-branch. */
  private assertBranchInScope(principal: Principal, branchId: string): void {
    if (principal.role === 'franchise-admin' || principal.role === 'super-admin') return;
    if (!principal.branchIds.includes(branchId)) {
      throw new ForbiddenException('Requested branch is outside your authorized scope');
    }
  }

  private async resolveRequestedBranches(
    principal: Principal,
    requestedIds: string[],
  ): Promise<Array<{ id: string; name: string }>> {
    const ids = Array.from(new Set(requestedIds));
    for (const id of ids) this.assertBranchInScope(principal, id);
    const rows = await this.branchRepository.find({
      where: { id: In(ids), status: 'active' },
      select: { id: true, name: true },
    });
    if (rows.length !== ids.length) {
      throw new BadRequestException('One or more assigned branches are invalid or inactive');
    }
    const byId = new Map(rows.map((row) => [row.id, row]));
    return ids.map((id) => byId.get(id)!);
  }

  private async branchDirectory(): Promise<BranchDirectory> {
    const rows = await this.branchRepository.find();
    const byName = new Map<string, Branch[]>();
    for (const branch of rows) {
      byName.set(branch.name, [...(byName.get(branch.name) ?? []), branch]);
    }
    return {
      byId: new Map(rows.map((branch) => [branch.id, branch])),
      byName,
    };
  }
}
