import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Principal } from '../auth/principal';
import { GovernanceAuditService } from '../governance/governance-audit.service';
import { GoTrueAdminService, GoTrueUser } from '../users/gotrue-admin.service';
import { Branch } from './branch.entity';

function confirmed(user: GoTrueUser): boolean {
  return Boolean(user.email_confirmed_at || user.confirmed_at);
}

function banned(user: GoTrueUser): boolean {
  return Boolean(user.banned_until && new Date(user.banned_until).getTime() > Date.now());
}

@Injectable()
export class BranchOwnerInvitationsService {
  constructor(
    @InjectRepository(Branch) private readonly branches: Repository<Branch>,
    private readonly goTrue: GoTrueAdminService,
    private readonly config: ConfigService,
    private readonly audit: GovernanceAuditService,
  ) {}

  async inviteNew(principal: Principal, name: string, recipient: string, phone?: string): Promise<GoTrueUser> {
    const email = recipient.trim().toLowerCase();
    if (await this.goTrue.findByEmail(email)) throw new ConflictException('Email already in use');
    const invited = await this.goTrue.inviteUser(email, name.trim(), this.redirect());
    // Never overwrite a concurrently provisioned identity or take over an existing role.
    if (invited.app_metadata?.role) throw new ConflictException('Email already in use');
    const sentAt = invited.confirmation_sent_at ?? invited.invited_at ?? new Date().toISOString();
    const appMetadata: Record<string, unknown> = {
      ...invited.app_metadata,
      username: email.split('@')[0], display_name: name.trim(), phone: phone ?? null,
      role: 'branch-owner', status: 'Pending', branch_ids: [], branches: [],
      branch_owner_invitation: true, invited_by: principal.userId,
      invited_by_name: principal.displayName ?? principal.username ?? principal.email ?? principal.userId,
      invited_at: invited.invited_at ?? sentAt,
      confirmation_sent_at: sentAt,
      invitation_expires_at: this.expiresAt(sentAt),
    };
    try {
      await this.goTrue.updateUser(invited.id, { app_metadata: appMetadata });
    } catch (error) {
      await this.goTrue.banUser(invited.id).catch(() => undefined);
      throw error;
    }
    return { ...invited, email, app_metadata: appMetadata };
  }

  async resend(principal: Principal, branchId: string): Promise<void> {
    const branch = await this.branches.findOne({ where: { id: branchId, status: 'active' } });
    if (!branch?.ownerId) throw new NotFoundException('Assigned Branch Owner not found');
    const current = await this.goTrue.getUser(branch.ownerId);
    if (!current || !this.isInvitation(current) || current.app_metadata.status !== 'Pending' ||
        current.app_metadata.invitation_branch_id !== branch.id || !current.email || banned(current)) {
      throw new ConflictException('Only a pending Branch Owner invitation can be resent');
    }
    if (confirmed(current)) {
      await this.goTrue.sendExistingUserLink(current.email, this.redirect());
    } else {
      await this.goTrue.inviteUser(current.email, String(current.app_metadata.display_name ?? current.email), this.redirect());
    }
    const sentAt = new Date().toISOString();
    await this.goTrue.updateUser(current.id, { app_metadata: {
      ...current.app_metadata, confirmation_sent_at: sentAt, invitation_expires_at: this.expiresAt(sentAt),
    } });
    await this.audit.record({
      category: 'branch-owner-change', action: 'branch-owner-invitation-resent', actor: principal,
      affectedRecordType: 'branch-owner-invitation', affectedRecordId: current.id, branchId: branch.id,
      afterState: { email: current.email, status: 'Pending', expiresAt: this.expiresAt(sentAt) },
    });
  }

  async accept(principal: Principal, password: string): Promise<void> {
    const initial = await this.goTrue.getUser(principal.userId);
    const branchId = initial?.app_metadata.invitation_branch_id;
    if (!initial || !this.isInvitation(initial) || typeof branchId !== 'string' || !principal.branchIds.includes(branchId)) {
      throw new ForbiddenException('This Branch Owner invitation is not valid');
    }
    // Serialize acceptance and reassignment on the canonical branch row. A retried
    // accepted session is idempotent and never changes the password a second time.
    await this.branches.manager.transaction(async (manager) => {
      const branch = await manager.findOne(Branch, {
        where: { id: branchId, ownerId: principal.userId, status: 'active' },
        lock: { mode: 'pessimistic_write' },
      });
      if (!branch) throw new ForbiddenException('The invitation branch is no longer assigned to this account');
      const current = await this.goTrue.getUser(principal.userId);
      if (!current || !this.isInvitation(current) || banned(current) || !confirmed(current) ||
          current.app_metadata.invitation_branch_id !== branch.id ||
          current.email?.toLowerCase() !== principal.email?.toLowerCase()) {
        throw new ForbiddenException('This Branch Owner invitation is not valid');
      }
      if (current.app_metadata.status === 'Active' && typeof current.app_metadata.invitation_accepted_at === 'string') return;
      const expires = new Date(String(current.app_metadata.invitation_expires_at)).getTime();
      if (current.app_metadata.status !== 'Pending' || !Number.isFinite(expires) || expires <= Date.now()) {
        throw new ForbiddenException('This invitation is inactive or expired. Ask the Franchise Administrator to resend it.');
      }
      await this.goTrue.updateUser(current.id, {
        password,
        app_metadata: { ...current.app_metadata, status: 'Active', invitation_accepted_at: new Date().toISOString() },
      });
      await this.audit.record({
        category: 'branch-owner-change', action: 'branch-owner-invitation-accepted', actor: principal,
        affectedRecordType: 'branch-owner-invitation', affectedRecordId: current.id, branchId: branch.id,
        beforeState: { status: 'Pending' },
        afterState: { status: 'Active', invitedBy: current.app_metadata.invited_by, email: current.email },
      }, manager);
    });
  }

  private isInvitation(user: GoTrueUser): boolean {
    return user.app_metadata.role === 'branch-owner' && user.app_metadata.branch_owner_invitation === true &&
      typeof user.app_metadata.invited_by === 'string';
  }

  private redirect(): string {
    const origin = (this.config.get<string>('WEB_ORIGIN') ?? 'http://localhost:3000').split(',')[0].trim().replace(/\/$/, '');
    return `${origin}/?invitation=branch-owner`;
  }

  private expiresAt(sentAt: string): string {
    const configured = Number(this.config.get<string>('SUPABASE_EMAIL_OTP_EXPIRY_SECONDS') ?? '3600');
    const seconds = Number.isFinite(configured) && configured > 0 ? configured : 3600;
    return new Date(new Date(sentAt).getTime() + seconds * 1000).toISOString();
  }
}
