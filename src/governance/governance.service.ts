import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'node:crypto';
import { DataSource, IsNull, Repository } from 'typeorm';
import { Principal } from '../auth/principal';
import { Branch } from '../branches/branch.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { PricesService } from '../prices/prices.service';
import { CYLINDER_SIZES, CylinderSize, UpdatePricesDto } from '../prices/dto/update-prices.dto';
import { SlaConfiguration, SlaSegment } from '../service-requests/sla-configuration.entity';
import { GoTrueAdminService, GoTrueUser } from '../users/gotrue-admin.service';
import { CreateGovernanceRequestDto } from './dto/create-governance-request.dto';
import { DecideGovernanceRequestDto } from './dto/decide-governance-request.dto';
import { ListGovernanceRequestsQuery } from './dto/list-governance.query';
import { GovernanceAuditCategory } from './governance-audit-event.entity';
import { GovernanceAuditService } from './governance-audit.service';
import {
  GovernanceRequest,
  GovernanceRequestStatus,
  GovernanceRequestType,
} from './governance-request.entity';

interface AppliedRequestResult {
  beforeState: Record<string, unknown> | null;
  afterState: Record<string, unknown> | null;
  affectedRecordType: string;
  affectedRecordId: string | null;
  temporaryPassword?: string;
}

interface PricePayload {
  prices: { cylinderSize: CylinderSize; unitPrice: number }[];
}

const SLA_SEGMENTS: readonly SlaSegment[] = [
  'request_to_dispatch',
  'dispatch_to_in_transit',
  'in_transit_to_delivery',
  'end_to_end',
];

function actorName(principal: Principal): string {
  return principal.displayName ?? principal.username ?? principal.email ?? principal.userId;
}

function metadataRole(user: GoTrueUser): string {
  return typeof user.app_metadata?.role === 'string' ? user.app_metadata.role : '';
}

function metadataBranches(user: GoTrueUser): string[] {
  const value = user.app_metadata?.branches;
  return Array.isArray(value)
    ? value.filter((branch): branch is string => typeof branch === 'string')
    : [];
}

@Injectable()
export class GovernanceService {
  constructor(
    @InjectRepository(GovernanceRequest)
    private readonly requests: Repository<GovernanceRequest>,
    @InjectRepository(Branch)
    private readonly branches: Repository<Branch>,
    @InjectRepository(SlaConfiguration)
    private readonly slaConfigurations: Repository<SlaConfiguration>,
    private readonly audit: GovernanceAuditService,
    private readonly prices: PricesService,
    private readonly notifications: NotificationsService,
    private readonly goTrue: GoTrueAdminService,
    private readonly dataSource: DataSource,
  ) {}

  async submit(
    principal: Principal,
    dto: CreateGovernanceRequestDto,
  ): Promise<GovernanceRequest> {
    if (dto.type === 'franchise-admin-account') {
      throw new ForbiddenException(
        'Franchise Administrator accounts use the Super Administrator invitation flow',
      );
    }
    await this.validateRequestPayload(dto);

    const request = this.requests.create({
      type: dto.type,
      status: 'pending',
      title: dto.title.trim(),
      reason: dto.reason.trim(),
      riskLevel: dto.riskLevel ?? this.defaultRisk(dto.type),
      branchId: dto.branchId ?? null,
      requestedBy: principal.userId,
      requestedByName: actorName(principal),
      payload: dto.payload,
      submittedAt: new Date(),
      decidedBy: null,
      decidedByName: null,
      decisionReason: null,
      decidedAt: null,
      appliedAt: null,
      deletedAt: null,
    });
    const saved = await this.requests.save(request);

    await this.audit.record({
      category: 'approval',
      action: 'governance-request-submitted',
      actor: principal,
      affectedRecordType: 'governance-request',
      affectedRecordId: saved.id,
      branchId: saved.branchId,
      governanceRequestId: saved.id,
      afterState: {
        type: saved.type,
        status: saved.status,
        title: saved.title,
        riskLevel: saved.riskLevel,
      },
      reason: saved.reason,
    });

    await this.notifications.publishForRole({
      type: 'system',
      audienceRole: 'super-admin',
      title: 'Governance request submitted',
      message: `${saved.requestedByName} submitted ${saved.title}.`,
    });
    return saved;
  }

  async list(principal: Principal, query: ListGovernanceRequestsQuery) {
    return this.requests.find({
      where: {
        ...(query.type ? { type: query.type } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(principal.role === 'franchise-admin' ? { requestedBy: principal.userId } : {}),
        deletedAt: IsNull(),
      },
      order: { submittedAt: 'DESC' },
      take: query.limit,
    });
  }

  async decide(
    principal: Principal,
    id: string,
    dto: DecideGovernanceRequestDto,
  ): Promise<{
    request: GovernanceRequest;
    temporaryPassword?: string;
  }> {
    const current = await this.requests.findOne({ where: { id, deletedAt: IsNull() } });
    if (!current) throw new NotFoundException('Governance request not found');
    if (current.requestedBy === principal.userId) {
      throw new ForbiddenException('A request cannot be approved by its requestor');
    }
    if (current.status !== 'pending') {
      throw new ConflictException('This request has already been reviewed');
    }
    if (
      current.type === 'franchise-admin-account' &&
      dto.decision !== 'reject'
    ) {
      throw new ForbiddenException(
        'Legacy Franchise Administrator requests can only be rejected; use the invitation flow',
      );
    }

    const claim = await this.requests
      .createQueryBuilder()
      .update(GovernanceRequest)
      .set({ status: 'applying' })
      .where('id = :id', { id })
      .andWhere('status = :status', { status: 'pending' })
      .andWhere('deleted_at IS NULL')
      .execute();
    if (claim.affected !== 1) {
      throw new ConflictException('Another reviewer is already handling this request');
    }

    const request = await this.requests.findOneOrFail({ where: { id } });
    let applied: AppliedRequestResult | null = null;
    try {
      if (dto.decision === 'approve') {
        applied = await this.applyApprovedRequest(principal, request);
      }
    } catch (error) {
      await this.requests.update({ id, status: 'applying' }, { status: 'pending' });
      throw error;
    }

    const finalStatus: GovernanceRequestStatus =
      dto.decision === 'approve'
        ? 'approved'
        : dto.decision === 'reject'
          ? 'rejected'
          : 'revision-requested';
    const now = new Date();
    request.status = finalStatus;
    request.decidedBy = principal.userId;
    request.decidedByName = actorName(principal);
    request.decisionReason = dto.reason.trim();
    request.decidedAt = now;
    request.appliedAt = dto.decision === 'approve' ? now : null;
    const saved = await this.requests.save(request);

    await this.audit.record({
      category: 'approval',
      action: `governance-request-${finalStatus}`,
      actor: principal,
      affectedRecordType: 'governance-request',
      affectedRecordId: request.id,
      branchId: request.branchId,
      governanceRequestId: request.id,
      beforeState: { status: 'pending' },
      afterState: { status: finalStatus },
      reason: dto.reason,
    });

    if (applied) {
      await this.audit.record({
        category: this.categoryFor(request.type),
        action: `${request.type}-applied`,
        actor: principal,
        affectedRecordType: applied.affectedRecordType,
        affectedRecordId: applied.affectedRecordId,
        branchId: request.branchId,
        governanceRequestId: request.id,
        beforeState: applied.beforeState,
        afterState: applied.afterState,
        reason: dto.reason,
      });
    }

    await this.notifications.publishForRole({
      type: 'system',
      audienceRole: 'franchise-admin',
      title: `Governance request ${finalStatus}`,
      message: `${request.title}: ${dto.reason.trim()}`,
    });

    return {
      request: saved,
      ...(applied?.temporaryPassword
        ? { temporaryPassword: applied.temporaryPassword }
        : {}),
    };
  }

  async dashboard() {
    const last30Days = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    // Keep this aggregate read within one connection at a time. Running every
    // count concurrently used all five pool slots, so one dashboard visit could
    // prevent unrelated BFF requests from obtaining a database connection.
    const pending = await this.requests.count({
      where: { status: 'pending', deletedAt: IsNull() },
    });
    const accountRequests = await this.requests.count({
      where: {
        type: 'franchise-admin-account',
        status: 'pending',
        deletedAt: IsNull(),
      },
    });
    const priceChanges30Days = await this.audit.count('price-change', last30Days);
    const branchOwnerChanges = await this.audit.count('branch-owner-change');
    const audits = await this.audit.list(undefined, 25);
    return {
      metrics: {
        pendingApprovals: pending,
        adminAccountRequests: accountRequests,
        priceChanges30Days,
        branchOwnerChanges,
      },
      priorityRequests: await this.requests.find({
        where: { status: 'pending', deletedAt: IsNull() },
        order: { riskLevel: 'DESC', submittedAt: 'ASC' },
        take: 8,
      }),
      recentActivity: audits.slice(0, 8),
      controls: {
        noSelfApproval: true,
        auditTrailActive: true,
        auditHistoryMutableByUsers: false,
      },
    };
  }

  async adminAccounts() {
    const [users, requests] = await Promise.all([
      this.goTrue.listUsers(),
      this.requests.find({
        where: { type: 'franchise-admin-account', deletedAt: IsNull() },
        order: { submittedAt: 'DESC' },
        take: 100,
      }),
    ]);
    return {
      accounts: users
        .filter((user) => metadataRole(user) === 'franchise-admin')
        .map((user) => ({
          id: user.id,
          email: user.email,
          username:
            typeof user.app_metadata.username === 'string'
              ? user.app_metadata.username
              : null,
          displayName:
            typeof user.app_metadata.display_name === 'string'
              ? user.app_metadata.display_name
              : null,
          phone:
            typeof user.app_metadata.phone === 'string' ? user.app_metadata.phone : null,
          status: user.app_metadata.status === 'Inactive' ? 'Inactive' : 'Active',
          createdAt: user.created_at,
        })),
      requests,
    };
  }

  async securitySummary() {
    const [users, activity, eventCount] = await Promise.all([
      this.goTrue.listUsers(),
      this.audit.list(undefined, 100),
      this.audit.count(),
    ]);
    const staff = users.filter((user) => metadataRole(user) !== 'customer');
    const active = (role: string) =>
      staff.filter(
        (user) =>
          metadataRole(user) === role && user.app_metadata.status !== 'Inactive',
      ).length;
    return {
      accountHealth: {
        activeSuperAdministrators: active('super-admin'),
        activeFranchiseAdministrators: active('franchise-admin'),
        inactiveAccounts: staff.filter(
          (user) => user.app_metadata.status === 'Inactive',
        ).length,
      },
      auditIntegrity: {
        approvalDecisionsRecorded: true,
        actorAndTimestampPresent: activity.every(
          (event) => Boolean(event.actorUserId && event.occurredAt),
        ),
        beforeAfterCoverage: activity
          .filter((event) => event.action.endsWith('-applied'))
          .every((event) => event.afterState !== null),
        eventCount,
      },
      signInTelemetry: {
        connected: false,
        message: 'Supabase Auth sign-in telemetry is not connected to the CRM audit stream.',
      },
      recentActivity: activity.slice(0, 20),
    };
  }

  private async applyApprovedRequest(
    principal: Principal,
    request: GovernanceRequest,
  ): Promise<AppliedRequestResult> {
    switch (request.type) {
      case 'price-configuration':
        return this.applyPriceRequest(request);
      case 'sla-threshold':
        return this.applySlaRequest(principal, request);
      case 'franchise-admin-account':
        return this.applyFranchiseAdminAccount(request);
      case 'branch-owner-change':
        return this.applyBranchOwnerChange(request);
      case 'branch-account':
      case 'other':
        return {
          beforeState: null,
          afterState: { approved: true },
          affectedRecordType: request.type,
          affectedRecordId: null,
        };
    }
  }

  private async applyPriceRequest(request: GovernanceRequest): Promise<AppliedRequestResult> {
    const payload = this.pricePayload(request.payload);
    const before = await this.prices.list();
    const after = await this.prices.updateAll(payload as UpdatePricesDto);
    return {
      beforeState: {
        prices: before.map((product) => ({
          productId: product.id,
          cylinderSize: product.cylinderSize,
          unitPrice: product.unitPrice,
        })),
      },
      afterState: {
        prices: after.map((product) => ({
          productId: product.id,
          cylinderSize: product.cylinderSize,
          unitPrice: product.unitPrice,
        })),
      },
      affectedRecordType: 'shared-price-catalog',
      affectedRecordId: null,
    };
  }

  private async applySlaRequest(
    principal: Principal,
    request: GovernanceRequest,
  ): Promise<AppliedRequestResult> {
    const segment = request.payload.segment;
    const thresholdMinutes = request.payload.thresholdMinutes;
    if (
      typeof segment !== 'string' ||
      !SLA_SEGMENTS.includes(segment as SlaSegment) ||
      !Number.isInteger(thresholdMinutes) ||
      (thresholdMinutes as number) < 1 ||
      (thresholdMinutes as number) > 1440
    ) {
      throw new BadRequestException('Invalid SLA threshold payload');
    }

    return this.dataSource.transaction(async (manager) => {
      const repository = manager.getRepository(SlaConfiguration);
      const existing = await repository.findOne({
        where: {
          branchId: request.branchId ?? IsNull(),
          segment: segment as SlaSegment,
          orderSource: 'all',
          isActive: true,
        },
        lock: { mode: 'pessimistic_write' },
      });
      const beforeState = existing
        ? { segment: existing.segment, thresholdMinutes: existing.thresholdMinutes }
        : null;
      const now = new Date();
      const row = existing ??
        repository.create({
          branchId: request.branchId,
          segment: segment as SlaSegment,
          orderSource: 'all',
          isActive: true,
          createdAt: now,
        });
      row.thresholdMinutes = thresholdMinutes as number;
      row.setBy = principal.userId;
      row.effectiveFrom = now;
      row.updatedAt = now;
      const saved = await repository.save(row);
      return {
        beforeState,
        afterState: {
          segment: saved.segment,
          thresholdMinutes: saved.thresholdMinutes,
        },
        affectedRecordType: 'sla-configuration',
        affectedRecordId: saved.id,
      };
    });
  }

  private async applyFranchiseAdminAccount(
    request: GovernanceRequest,
  ): Promise<AppliedRequestResult> {
    const email = request.payload.email;
    const name = request.payload.name;
    const phone = request.payload.phone;
    const username = request.payload.username;
    if (
      typeof email !== 'string' ||
      typeof name !== 'string' ||
      (phone !== undefined && phone !== null && typeof phone !== 'string') ||
      (username !== undefined && typeof username !== 'string')
    ) {
      throw new BadRequestException('Invalid Franchise Administrator account payload');
    }
    const existing = await this.goTrue.findByEmail(email);
    if (existing) {
      throw new ConflictException('An account with this email already exists');
    }

    const temporaryPassword = this.generateTemporaryPassword();
    const created = await this.goTrue.createUser({
      email,
      password: temporaryPassword,
      email_confirm: true,
      app_metadata: {
        username: username?.trim() || email.split('@')[0],
        display_name: name.trim(),
        role: 'franchise-admin',
        branches: [],
        phone: phone ?? null,
        status: 'Active',
        must_change_password: true,
      },
    });
    return {
      beforeState: null,
      afterState: { id: created.id, email, name: name.trim(), status: 'Active' },
      affectedRecordType: 'franchise-admin-account',
      affectedRecordId: created.id,
      temporaryPassword,
    };
  }

  private async applyBranchOwnerChange(
    request: GovernanceRequest,
  ): Promise<AppliedRequestResult> {
    if (!request.branchId) throw new BadRequestException('A branch is required');
    const newOwnerId = request.payload.newOwnerId;
    if (typeof newOwnerId !== 'string') {
      throw new BadRequestException('A new Branch Owner is required');
    }
    const branch = await this.branches.findOne({
      where: { id: request.branchId, status: 'active' },
    });
    if (!branch) throw new NotFoundException('Branch not found');

    const users = await this.goTrue.listUsers();
    const newOwner = users.find((user) => user.id === newOwnerId);
    if (!newOwner || metadataRole(newOwner) !== 'branch-owner') {
      throw new BadRequestException('The selected account is not a Branch Owner');
    }
    const previousOwners = users.filter(
      (user) =>
        user.id !== newOwnerId &&
        metadataRole(user) === 'branch-owner' &&
        metadataBranches(user).includes(branch.name),
    );

    if (
      newOwner.app_metadata.status === 'Inactive' ||
      (newOwner.banned_until !== null &&
        newOwner.banned_until !== undefined &&
        new Date(newOwner.banned_until).getTime() > Date.now())
    ) {
      throw new BadRequestException('The selected Branch Owner account is inactive');
    }

    const newOwnerBranches = metadataBranches(newOwner);
    if (!newOwnerBranches.includes(branch.name)) {
      await this.goTrue.updateUser(newOwner.id, {
        app_metadata: {
          ...newOwner.app_metadata,
          branches: [...newOwnerBranches, branch.name],
          status: 'Active',
        },
      });
    }

    // Provision the incoming owner first so an external GoTrue failure cannot
    // leave the branch with no active owner. A retry is idempotent and removes
    // any remaining previous assignments.
    for (const previous of previousOwners) {
      await this.goTrue.updateUser(previous.id, {
        app_metadata: {
          ...previous.app_metadata,
          branches: metadataBranches(previous).filter((name) => name !== branch.name),
        },
      });
    }

    return {
      beforeState: {
        owners: previousOwners.map((owner) => ({ id: owner.id, email: owner.email })),
      },
      afterState: { owner: { id: newOwner.id, email: newOwner.email }, branch: branch.name },
      affectedRecordType: 'branch-owner-assignment',
      affectedRecordId: branch.id,
    };
  }

  private async validateRequestPayload(dto: CreateGovernanceRequestDto): Promise<void> {
    if (dto.branchId) {
      const branch = await this.branches.findOne({
        where: { id: dto.branchId, status: 'active' },
        select: { id: true },
      });
      if (!branch) throw new NotFoundException('Branch not found');
    }
    switch (dto.type) {
      case 'price-configuration':
        this.pricePayload(dto.payload);
        return;
      case 'sla-threshold': {
        const segment = dto.payload.segment;
        const threshold = dto.payload.thresholdMinutes;
        if (
          typeof segment !== 'string' ||
          !SLA_SEGMENTS.includes(segment as SlaSegment) ||
          !Number.isInteger(threshold) ||
          (threshold as number) < 1 ||
          (threshold as number) > 1440
        ) {
          throw new BadRequestException('Invalid SLA threshold payload');
        }
        return;
      }
      case 'franchise-admin-account': {
        const { email, name, phone } = dto.payload;
        if (
          typeof email !== 'string' ||
          !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ||
          typeof name !== 'string' ||
          name.trim().length < 2 ||
          (phone !== undefined && phone !== null && !/^\+639\d{9}$/.test(String(phone)))
        ) {
          throw new BadRequestException('Invalid Franchise Administrator account payload');
        }
        if (await this.goTrue.findByEmail(email)) {
          throw new ConflictException('An account with this email already exists');
        }
        return;
      }
      case 'branch-owner-change':
        if (!dto.branchId || typeof dto.payload.newOwnerId !== 'string') {
          throw new BadRequestException('Branch Owner changes require branchId and newOwnerId');
        }
        return;
      case 'branch-account':
      case 'other':
        return;
    }
  }

  private pricePayload(payload: Record<string, unknown>): PricePayload {
    const rows = payload.prices;
    if (!Array.isArray(rows) || rows.length !== CYLINDER_SIZES.length) {
      throw new BadRequestException('Submit one price for every supported cylinder size');
    }
    const parsed = rows.map((row) => {
      if (!row || typeof row !== 'object') {
        throw new BadRequestException('Invalid price request payload');
      }
      const input = row as Record<string, unknown>;
      if (
        typeof input.cylinderSize !== 'string' ||
        !CYLINDER_SIZES.includes(input.cylinderSize as CylinderSize) ||
        typeof input.unitPrice !== 'number' ||
        !Number.isFinite(input.unitPrice) ||
        input.unitPrice <= 0
      ) {
        throw new BadRequestException('Invalid price request payload');
      }
      return {
        cylinderSize: input.cylinderSize as CylinderSize,
        unitPrice: input.unitPrice,
      };
    });
    if (new Set(parsed.map((row) => row.cylinderSize)).size !== CYLINDER_SIZES.length) {
      throw new BadRequestException('Cylinder sizes must be unique');
    }
    return { prices: parsed };
  }

  private defaultRisk(type: GovernanceRequestType): 'low' | 'medium' | 'high' {
    if (type === 'sla-threshold' || type === 'franchise-admin-account') return 'high';
    if (type === 'price-configuration' || type === 'branch-owner-change') return 'medium';
    return 'low';
  }

  private categoryFor(type: GovernanceRequestType): GovernanceAuditCategory {
    switch (type) {
      case 'franchise-admin-account':
        return 'admin-account';
      case 'price-configuration':
        return 'price-change';
      case 'branch-owner-change':
        return 'branch-owner-change';
      case 'sla-threshold':
        return 'sla-configuration';
      case 'branch-account':
      case 'other':
        return 'approval';
    }
  }

  private generateTemporaryPassword(): string {
    return `SkGz-${randomBytes(8).toString('base64url')}!9`;
  }
}
