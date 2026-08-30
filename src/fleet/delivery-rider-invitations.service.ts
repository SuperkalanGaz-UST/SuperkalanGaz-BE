import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { In, QueryFailedError, Repository } from 'typeorm';
import { metadataBranchIds, withBranchScope } from '../auth/branch-scope';
import { Principal } from '../auth/principal';
import { Branch } from '../branches/branch.entity';
import { GovernanceAuditService } from '../governance/governance-audit.service';
import { GoTrueAdminService, GoTrueUser } from '../users/gotrue-admin.service';
import { CreateDeliveryRiderInvitationDto } from './dto/create-delivery-rider-invitation.dto';
import { ListDeliveryRiderInvitationsQuery } from './dto/delivery-rider-invitation.dto';
import { Rider } from './rider.entity';

const META = {
  tokenHash: 'delivery_rider_invitation_token_hash',
  invitedBy: 'delivery_rider_invited_by',
  invitedByName: 'delivery_rider_invited_by_name',
  invitedAt: 'delivery_rider_invited_at',
  sentAt: 'delivery_rider_confirmation_sent_at',
  expiresAt: 'delivery_rider_invitation_expires_at',
  revokedAt: 'delivery_rider_invitation_revoked_at',
  accountCreatedAt: 'delivery_rider_account_created_at',
  mobileVerifiedAt: 'delivery_rider_mobile_verified_at',
  acceptedAt: 'delivery_rider_invitation_accepted_at',
} as const;

export type DeliveryRiderInvitationStatus =
  | 'Pending'
  | 'Expired'
  | 'Revoked'
  | 'Accepted';

export interface DeliveryRiderInvitationView {
  invitationId: string;
  recipientName: string;
  email: string;
  mobile: string;
  branchId: string;
  branchName: string;
  status: DeliveryRiderInvitationStatus;
  invitedAt: string;
  confirmationSentAt: string;
  expiresAt: string;
  emailVerified: boolean;
  accountCreated: boolean;
  mobileVerified: boolean;
}

function metadataString(user: GoTrueUser, key: string): string | null {
  const value = user.app_metadata?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isEmailVerified(user: GoTrueUser): boolean {
  return Boolean(user.email_confirmed_at ?? user.confirmed_at);
}

function actorName(principal: Principal): string {
  return principal.displayName ?? principal.username ?? principal.email ?? principal.userId;
}

@Injectable()
export class DeliveryRiderInvitationsService {
  constructor(
    @InjectRepository(Branch)
    private readonly branches: Repository<Branch>,
    @InjectRepository(Rider)
    private readonly riders: Repository<Rider>,
    private readonly goTrue: GoTrueAdminService,
    private readonly audit: GovernanceAuditService,
    private readonly config: ConfigService,
  ) {}

  async list(
    principal: Principal,
    query: ListDeliveryRiderInvitationsQuery,
  ): Promise<DeliveryRiderInvitationView[]> {
    const scope = this.ownerScope(principal);
    if (query.branchId && !scope.includes(query.branchId)) {
      throw new ForbiddenException('The selected branch is outside your scope');
    }
    const requestedScope = query.branchId ? [query.branchId] : scope;
    const branches = await this.branches.find({
      where: { id: In(requestedScope), status: 'active' },
      select: { id: true, name: true },
    });
    const names = new Map(branches.map((branch) => [branch.id, branch.name]));

    return (await this.goTrue.listUsers())
      .filter((user) => this.isDeliveryRiderInvitation(user))
      .filter((user) => requestedScope.includes(this.userBranchId(user) ?? ''))
      .map((user) => this.toView(user, names.get(this.userBranchId(user) ?? '') ?? ''))
      .sort(
        (left, right) =>
          new Date(right.invitedAt).getTime() - new Date(left.invitedAt).getTime(),
      );
  }

  async create(
    principal: Principal,
    dto: CreateDeliveryRiderInvitationDto,
  ): Promise<DeliveryRiderInvitationView> {
    const branch = await this.requireOwnedBranch(principal, dto.branchId);
    const email = dto.email.trim().toLowerCase();
    const recipientName = dto.recipientName.trim().replace(/\s+/g, ' ');
    const users = await this.goTrue.listUsers();
    const emailUser = users.find(
      (user) => (user.email ?? '').toLowerCase() === email,
    );
    const mobileUser = users.find(
      (user) =>
        user.phone === dto.mobile || metadataString(user, 'phone') === dto.mobile,
    );

    if (emailUser) {
      const existingBranchId = this.userBranchId(emailUser);
      const canReissue =
        this.isDeliveryRiderInvitation(emailUser) &&
        this.statusFor(emailUser) === 'Revoked' &&
        existingBranchId !== null &&
        this.ownerScope(principal).includes(existingBranchId);

      if (!canReissue) {
        throw new ConflictException('An account or invitation with this email already exists');
      }
      if (mobileUser && mobileUser.id !== emailUser.id) {
        throw new ConflictException(
          'An account or invitation with this mobile number already exists',
        );
      }

      return this.reissueRevokedInvitation(principal, emailUser, branch, {
        email,
        mobile: dto.mobile,
        recipientName,
      });
    }

    if (mobileUser) {
      throw new ConflictException(
        'An account or invitation with this mobile number already exists',
      );
    }

    const rawToken = randomBytes(32).toString('base64url');
    const invited = await this.goTrue.inviteUser(
      email,
      recipientName,
      this.invitationRedirect(rawToken),
    );
    const now = new Date();
    const invitedAt = invited.invited_at ?? invited.confirmation_sent_at ?? now.toISOString();
    const sentAt = invited.confirmation_sent_at ?? invitedAt;
    const expiresAt = this.expiresFrom(now).toISOString();
    const scoped = withBranchScope(invited.app_metadata, [branch]);
    const appMetadata: Record<string, unknown> = {
      ...scoped,
      branch_id: branch.id,
      username: email.split('@')[0],
      display_name: recipientName,
      role: 'driver',
      phone: dto.mobile,
      status: 'Pending',
      [META.tokenHash]: this.digest(rawToken),
      [META.invitedBy]: principal.userId,
      [META.invitedByName]: actorName(principal),
      [META.invitedAt]: invitedAt,
      [META.sentAt]: sentAt,
      [META.expiresAt]: expiresAt,
    };
    await this.goTrue.updateUser(invited.id, { app_metadata: appMetadata });

    const invitation = this.toView(
      { ...invited, email, app_metadata: appMetadata },
      branch.name,
    );
    await this.audit.record({
      category: 'security',
      action: 'delivery-rider-invitation-sent',
      actor: principal,
      affectedRecordType: 'delivery-rider-invitation',
      affectedRecordId: invited.id,
      branchId: branch.id,
      afterState: {
        email,
        mobile: dto.mobile,
        recipientName,
        status: invitation.status,
        expiresAt,
      },
    });
    return invitation;
  }

  async resend(
    principal: Principal,
    id: string,
  ): Promise<DeliveryRiderInvitationView> {
    const current = await this.requireManagedInvitation(principal, id);
    if (current.app_metadata.status === 'Revoked') {
      const branch = await this.requiredInvitationBranch(current);
      if (!current.email) throw new BadRequestException('Invitation email is missing');
      const mobile = metadataString(current, 'phone');
      if (!mobile) throw new BadRequestException('Invitation mobile number is missing');

      return this.reissueRevokedInvitation(principal, current, branch, {
        email: current.email.toLowerCase(),
        mobile,
        recipientName: metadataString(current, 'display_name') ?? current.email,
      });
    }
    if (current.app_metadata.status === 'Active') {
      throw new ConflictException('This invitation has already been accepted');
    }
    if (isEmailVerified(current)) {
      throw new ConflictException(
        'The email is already verified; the recipient can continue in the mobile app',
      );
    }
    if (!current.email) throw new BadRequestException('Invitation email is missing');

    const rawToken = randomBytes(32).toString('base64url');
    const recipientName = metadataString(current, 'display_name') ?? current.email;
    const resent = await this.goTrue.inviteUser(
      current.email,
      recipientName,
      this.invitationRedirect(rawToken),
    );
    if (resent.id !== current.id) {
      throw new ConflictException('The invitation identity changed unexpectedly');
    }
    const sentAt = resent.confirmation_sent_at ?? new Date().toISOString();
    const expiresAt = this.expiresFrom(new Date()).toISOString();
    const appMetadata = {
      ...current.app_metadata,
      status: 'Pending',
      [META.tokenHash]: this.digest(rawToken),
      [META.sentAt]: sentAt,
      [META.expiresAt]: expiresAt,
    };
    await this.goTrue.updateUser(id, { app_metadata: appMetadata });
    const branchId = this.userBranchId(current);
    const branch = branchId
      ? await this.branches.findOne({ where: { id: branchId, status: 'active' } })
      : null;
    const invitation = this.toView(
      { ...current, ...resent, app_metadata: appMetadata },
      branch?.name ?? '',
    );
    await this.audit.record({
      category: 'security',
      action: 'delivery-rider-invitation-resent',
      actor: principal,
      affectedRecordType: 'delivery-rider-invitation',
      affectedRecordId: id,
      branchId,
      beforeState: { status: this.statusFor(current) },
      afterState: { status: invitation.status, expiresAt },
    });
    return invitation;
  }

  async revoke(
    principal: Principal,
    id: string,
    reason: string,
  ): Promise<DeliveryRiderInvitationView> {
    const current = await this.requireManagedInvitation(principal, id);
    if (current.app_metadata.status === 'Revoked') {
      throw new ConflictException('This invitation has already been revoked');
    }
    if (current.app_metadata.status === 'Active') {
      throw new ConflictException('An accepted invitation cannot be revoked');
    }
    const revokedAt = new Date().toISOString();
    const appMetadata = {
      ...current.app_metadata,
      status: 'Revoked',
      [META.revokedAt]: revokedAt,
    };
    await this.goTrue.updateUser(id, { app_metadata: appMetadata });
    await this.goTrue.banUser(id);
    const branchId = this.userBranchId(current);
    const branch = branchId
      ? await this.branches.findOne({ where: { id: branchId, status: 'active' } })
      : null;
    const invitation = this.toView(
      { ...current, app_metadata: appMetadata },
      branch?.name ?? '',
    );
    await this.audit.record({
      category: 'security',
      action: 'delivery-rider-invitation-revoked',
      actor: principal,
      affectedRecordType: 'delivery-rider-invitation',
      affectedRecordId: id,
      branchId,
      beforeState: { status: this.statusFor(current) },
      afterState: { status: 'Revoked', revokedAt },
      reason,
    });
    return invitation;
  }

  async acceptance(token: string): Promise<DeliveryRiderInvitationView> {
    const user = await this.liveInvitationForToken(token);
    const branch = await this.requiredInvitationBranch(user);
    return this.toView(user, branch.name);
  }

  async createAccount(token: string, password: string): Promise<void> {
    const user = await this.liveInvitationForToken(token);
    if (!isEmailVerified(user)) {
      throw new ForbiddenException('Open the verified email invitation before continuing');
    }
    if (metadataString(user, META.accountCreatedAt)) {
      throw new ConflictException('The Delivery Rider account password is already set');
    }
    const phone = metadataString(user, 'phone');
    if (!phone) throw new BadRequestException('The invitation mobile number is missing');
    const accountCreatedAt = new Date().toISOString();
    await this.goTrue.updateUser(user.id, {
      password,
      phone,
      phone_confirm: false,
      app_metadata: {
        ...user.app_metadata,
        [META.accountCreatedAt]: accountCreatedAt,
      },
    });
  }

  async sendMobileCode(token: string): Promise<void> {
    const user = await this.liveInvitationForToken(token);
    if (!metadataString(user, META.accountCreatedAt)) {
      throw new ConflictException('Create the account password before verifying mobile');
    }
    const phone = metadataString(user, 'phone');
    if (!phone) throw new BadRequestException('The invitation mobile number is missing');
    await this.goTrue.requestPhoneOtp(phone);
  }

  async verifyMobile(token: string, code: string): Promise<void> {
    const user = await this.liveInvitationForToken(token);
    if (!metadataString(user, META.accountCreatedAt)) {
      throw new ConflictException('Create the account password before verifying mobile');
    }
    const phone = metadataString(user, 'phone');
    if (!phone) throw new BadRequestException('The invitation mobile number is missing');
    const verified = await this.goTrue.verifyPhoneOtp(phone, code);
    if (verified.userId !== user.id) {
      throw new ForbiddenException('The verification code belongs to another account');
    }
    await this.goTrue.updateUser(user.id, {
      phone_confirm: true,
      app_metadata: {
        ...user.app_metadata,
        [META.mobileVerifiedAt]: new Date().toISOString(),
      },
    });
  }

  async accept(token: string): Promise<void> {
    const tokenUser = await this.liveInvitationForToken(token);
    const user = await this.goTrue.getUser(tokenUser.id);
    if (!user || !isEmailVerified(user)) {
      throw new ForbiddenException('The invitation email has not been verified');
    }
    if (!metadataString(user, META.accountCreatedAt)) {
      throw new ConflictException('Create the account password before accepting');
    }
    if (!metadataString(user, META.mobileVerifiedAt)) {
      throw new ConflictException('Verify the invitation mobile number before accepting');
    }
    const branch = await this.requiredInvitationBranch(user);
    const now = new Date();
    const rider = this.riders.create({
      authUserId: user.id,
      branchId: branch.id,
      name: metadataString(user, 'display_name') ?? user.email ?? 'Delivery Rider',
      plate: 'Unassigned',
      status: 'Offline',
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
    let saved: Rider;
    try {
      saved = await this.riders.save(rider);
    } catch (error) {
      if (
        error instanceof QueryFailedError &&
        (error as { code?: string }).code === '23505'
      ) {
        throw new ConflictException('This invitation is already being accepted');
      }
      throw error;
    }

    const acceptedAt = now.toISOString();
    const appMetadata = {
      ...user.app_metadata,
      status: 'Active',
      [META.acceptedAt]: acceptedAt,
    };
    await this.goTrue.updateUser(user.id, { app_metadata: appMetadata });
    await this.audit.record({
      category: 'security',
      action: 'delivery-rider-invitation-accepted',
      actor: {
        userId: user.id,
        role: 'driver',
        displayName: metadataString(user, 'display_name'),
        username: metadataString(user, 'username'),
        email: user.email,
      },
      affectedRecordType: 'delivery-rider-account',
      affectedRecordId: user.id,
      branchId: branch.id,
      beforeState: { status: 'Pending' },
      afterState: {
        status: 'Active',
        rosterId: saved.id,
        availability: 'Offline',
        invitedBy: metadataString(user, META.invitedBy),
      },
    });
  }

  private async requireManagedInvitation(
    principal: Principal,
    id: string,
  ): Promise<GoTrueUser> {
    const user = await this.goTrue.getUser(id);
    if (!user || !this.isDeliveryRiderInvitation(user)) {
      throw new NotFoundException('Delivery Rider invitation not found');
    }
    const branchId = this.userBranchId(user);
    if (!branchId || !this.ownerScope(principal).includes(branchId)) {
      throw new NotFoundException('Delivery Rider invitation not found');
    }
    return user;
  }

  private async reissueRevokedInvitation(
    principal: Principal,
    current: GoTrueUser,
    branch: Branch,
    identity: { email: string; mobile: string; recipientName: string },
  ): Promise<DeliveryRiderInvitationView> {
    const roster = await this.riders.findOne({
      where: { authUserId: current.id },
      select: { id: true },
    });
    if (roster || this.statusFor(current) !== 'Revoked') {
      throw new ConflictException(
        'This email already belongs to a Delivery Rider account',
      );
    }

    const rawToken = randomBytes(32).toString('base64url');
    const redirect = this.invitationRedirect(rawToken);
    const now = new Date();
    const invitedAt = now.toISOString();
    const expiresAt = this.expiresFrom(now).toISOString();
    const revokedMetadata = { ...current.app_metadata };
    const previousBranchId = this.userBranchId(current);
    const appMetadata: Record<string, unknown> = {
      ...withBranchScope(revokedMetadata, [branch]),
      branch_id: branch.id,
      username: identity.email.split('@')[0],
      display_name: identity.recipientName,
      role: 'driver',
      phone: identity.mobile,
      status: 'Pending',
      [META.tokenHash]: this.digest(rawToken),
      [META.invitedBy]: principal.userId,
      [META.invitedByName]: actorName(principal),
      [META.invitedAt]: invitedAt,
      [META.sentAt]: invitedAt,
      [META.expiresAt]: expiresAt,
      // GoTrue merges app_metadata updates; explicit nulls retire state from
      // the revoked onboarding attempt while retaining its immutable audit.
      [META.revokedAt]: null,
      [META.accountCreatedAt]: null,
      [META.mobileVerifiedAt]: null,
      [META.acceptedAt]: null,
    };

    // Keep the retained identity blocked until its protected claims contain the
    // fresh token and scope. If delivery fails, restore the revoked state so no
    // partially reissued account can authenticate.
    await this.goTrue.updateUser(current.id, { app_metadata: appMetadata });
    try {
      await this.goTrue.unbanUser(current.id);
      if (isEmailVerified(current)) {
        await this.goTrue.sendExistingUserLink(identity.email, redirect);
      } else {
        const resent = await this.goTrue.inviteUser(
          identity.email,
          identity.recipientName,
          redirect,
        );
        if (resent.id !== current.id) {
          throw new ConflictException('The invitation identity changed unexpectedly');
        }
      }
    } catch (error) {
      await Promise.allSettled([
        this.goTrue.updateUser(current.id, {
          app_metadata: revokedMetadata,
        }),
        this.goTrue.banUser(current.id),
      ]);
      throw error;
    }

    const invitation = this.toView(
      {
        ...current,
        email: identity.email,
        app_metadata: appMetadata,
        invited_at: invitedAt,
        confirmation_sent_at: invitedAt,
        banned_until: null,
      },
      branch.name,
    );
    await this.audit.record({
      category: 'security',
      action: 'delivery-rider-invitation-reissued',
      actor: principal,
      affectedRecordType: 'delivery-rider-invitation',
      affectedRecordId: current.id,
      branchId: branch.id,
      beforeState: {
        status: 'Revoked',
        branchId: previousBranchId,
      },
      afterState: {
        status: invitation.status,
        email: identity.email,
        mobile: identity.mobile,
        recipientName: identity.recipientName,
        branchId: branch.id,
        expiresAt,
      },
    });
    return invitation;
  }

  private async liveInvitationForToken(token: string): Promise<GoTrueUser> {
    const digest = this.digest(token);
    const user = (await this.goTrue.listUsers()).find((candidate) => {
      const stored = metadataString(candidate, META.tokenHash);
      return stored ? this.sameDigest(stored, digest) : false;
    });
    if (
      !user ||
      !this.isDeliveryRiderInvitation(user) ||
      user.app_metadata.status !== 'Pending' ||
      metadataString(user, META.revokedAt) ||
      metadataString(user, META.acceptedAt) ||
      this.statusFor(user) === 'Expired'
    ) {
      throw new NotFoundException(
        'This Delivery Rider invitation is invalid, expired, revoked, or already used',
      );
    }
    return user;
  }

  private async requiredInvitationBranch(user: GoTrueUser): Promise<Branch> {
    const branchId = this.userBranchId(user);
    const branch = branchId
      ? await this.branches.findOne({ where: { id: branchId, status: 'active' } })
      : null;
    if (!branch) throw new ForbiddenException('The invitation branch is unavailable');
    return branch;
  }

  private async requireOwnedBranch(
    principal: Principal,
    branchId: string,
  ): Promise<Branch> {
    if (!this.ownerScope(principal).includes(branchId)) {
      throw new ForbiddenException('The selected branch is outside your scope');
    }
    const branch = await this.branches.findOne({
      where: { id: branchId, status: 'active' },
    });
    if (!branch) throw new ForbiddenException('The selected branch is unavailable');
    return branch;
  }

  private ownerScope(principal: Principal): string[] {
    if (principal.role !== 'branch-owner' || principal.branchIds.length === 0) {
      throw new ForbiddenException('A Branch Owner with an active branch is required');
    }
    return principal.branchIds;
  }

  private isDeliveryRiderInvitation(user: GoTrueUser): boolean {
    return (
      user.app_metadata?.role === 'driver' &&
      typeof user.app_metadata?.[META.invitedBy] === 'string'
    );
  }

  private userBranchId(user: GoTrueUser): string | null {
    return metadataBranchIds(user.app_metadata)[0] ?? null;
  }

  private statusFor(user: GoTrueUser): DeliveryRiderInvitationStatus {
    if (user.app_metadata.status === 'Active' || metadataString(user, META.acceptedAt)) {
      return 'Accepted';
    }
    if (user.app_metadata.status === 'Revoked' || metadataString(user, META.revokedAt)) {
      return 'Revoked';
    }
    const expiresAt = metadataString(user, META.expiresAt);
    if (!expiresAt || new Date(expiresAt).getTime() <= Date.now()) return 'Expired';
    return 'Pending';
  }

  private toView(user: GoTrueUser, branchName: string): DeliveryRiderInvitationView {
    const invitedAt = metadataString(user, META.invitedAt) ?? user.created_at;
    const sentAt = metadataString(user, META.sentAt) ?? user.confirmation_sent_at ?? invitedAt;
    return {
      invitationId: user.id,
      recipientName:
        metadataString(user, 'display_name') ?? user.email ?? 'Delivery Rider',
      email: user.email ?? '',
      mobile: metadataString(user, 'phone') ?? user.phone ?? '',
      branchId: this.userBranchId(user) ?? '',
      branchName,
      status: this.statusFor(user),
      invitedAt,
      confirmationSentAt: sentAt,
      expiresAt: metadataString(user, META.expiresAt) ?? sentAt,
      emailVerified: isEmailVerified(user),
      accountCreated: Boolean(metadataString(user, META.accountCreatedAt)),
      mobileVerified: Boolean(
        metadataString(user, META.mobileVerifiedAt) ?? user.phone_confirmed_at,
      ),
    };
  }

  private invitationRedirect(token: string): string {
    const base = (
      this.config.get<string>('DELIVERY_RIDER_INVITATION_REDIRECT_URL') ??
      'superkalan://delivery-rider-invitation'
    ).replace(/[?&]token=[^&#]*/i, '');
    return `${base}${base.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
  }

  private expiresFrom(from: Date): Date {
    const configured = Number(
      this.config.get<string>('DELIVERY_RIDER_INVITATION_EXPIRY_HOURS') ?? '48',
    );
    const hours = Number.isFinite(configured) && configured > 0 ? configured : 48;
    return new Date(from.getTime() + hours * 60 * 60 * 1000);
  }

  private digest(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private sameDigest(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left, 'utf8');
    const rightBuffer = Buffer.from(right, 'utf8');
    return (
      leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
    );
  }
}
