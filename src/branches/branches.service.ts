import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'crypto';
import { In, QueryFailedError, Repository } from 'typeorm';
import { Principal } from '../auth/principal';
import {
  hasMetadataBranchIds,
  metadataBranchIds,
  metadataBranchNames,
  withBranchScope,
} from '../auth/branch-scope';
import { GovernanceAuditService } from '../governance/governance-audit.service';
import { GoTrueAdminService, GoTrueUser } from '../users/gotrue-admin.service';
import { Branch, BranchGeofence } from './branch.entity';
import { CreateBranchDto } from './dto/create-branch.dto';
import { UpdateBranchDto } from './dto/update-branch.dto';

/** Postgres unique_violation — raised by the partial unique index on code. */
const PG_UNIQUE_VIOLATION = '23505';

/** Details of an owner login provisioned as part of branch creation. */
export interface ProvisionedOwner {
  id: string;
  email: string;
  /** Plaintext one-time password — returned once so the UI can hand it over. */
  tempPassword: string;
}

export interface CreateBranchResult {
  id: string;
  code: string;
  owner: ProvisionedOwner | null;
}

/** One branch as served to the Franchise Registry list. */
export interface BranchRow {
  id: string;
  name: string;
  code: string;
  status: 'active' | 'inactive';
  province: string | null;
  city: string | null;
  address: string | null;
  contact_number: string | null;
  geofence: BranchGeofence | null;
  source_store_location_id: string | null;
  owner_id: string | null;
  created_at: Date;
}

/** Branch configuration visible to a Branch Owner for an assigned branch. */
export interface AssignedBranchRow {
  id: string;
  name: string;
  geofence: BranchGeofence | null;
}

/** URL-safe temp password; 16 chars easily clears Supabase's default policy. */
function generateTempPassword(): string {
  return randomBytes(12).toString('base64url');
}

/**
 * Derives a stable branch code from the name: an uppercased slug plus a short
 * random suffix so genuinely different stores that share a name (e.g. the two
 * "LAGUNA PREMIUM GAS" locations) never collide. The suffix is re-rolled on the
 * rare unique-index clash.
 */
function generateBranchCode(name: string): string {
  const slug = name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const suffix = randomBytes(3).toString('hex').toUpperCase(); // 6 hex chars
  return slug ? `${slug}-${suffix}` : `BRANCH-${suffix}`;
}

/**
 * Branch registry. Only Franchise Admins reach these handlers (enforced at the
 * controller); FA is cross-branch, so there is no per-branch scope check here.
 * Soft delete is status-based (AGENTS.md §3.2) — no hard deletes. Data lives in
 * core.branches (7-schema design, AGENTS.md §6).
 */
@Injectable()
export class BranchesService {
  constructor(
    @InjectRepository(Branch)
    private readonly branches: Repository<Branch>,
    private readonly goTrue: GoTrueAdminService,
    @Optional()
    private readonly governanceAudit?: GovernanceAuditService,
  ) {}

  async create(principal: Principal, dto: CreateBranchDto): Promise<CreateBranchResult> {
    const name = dto.name.trim();

    let existingOwner: GoTrueUser | null = null;
    if (dto.ownerType === 'existing') {
      existingOwner = dto.ownerId
        ? await this.goTrue.getUser(dto.ownerId)
        : dto.ownerEmail
          ? await this.goTrue.findByEmail(dto.ownerEmail)
          : null;
      if (
        !existingOwner ||
        existingOwner.app_metadata?.role !== 'branch-owner' ||
        existingOwner.app_metadata?.status === 'Inactive'
      ) {
        throw new BadRequestException('Select an active Branch Owner account');
      }
    }

    // The branch UUID does not exist until persistence, so a new owner's initial
    // protected scope starts empty and is filled immediately after the branch row
    // is saved. Names remain display-only metadata; branch_ids is authoritative.
    let owner: ProvisionedOwner | null = null;
    let newOwnerMetadata: Record<string, unknown> | null = null;
    if (dto.ownerType === 'new') {
      if (!dto.ownerEmail || !dto.ownerName) {
        throw new BadRequestException('A new owner requires a name and email address');
      }
      const tempPassword = generateTempPassword();
      newOwnerMetadata = {
        username: dto.ownerEmail.split('@')[0],
        display_name: dto.ownerName,
        role: 'branch-owner',
        branch_ids: [],
        branches: [],
        phone: dto.ownerMobile ?? null,
        status: 'Active',
      };
      const { id } = await this.goTrue.createUser({
        email: dto.ownerEmail,
        password: tempPassword,
        email_confirm: true,
        app_metadata: newOwnerMetadata,
      });
      owner = { id, email: dto.ownerEmail, tempPassword };
    }

    const now = new Date();

    // Insert, re-rolling the code once if the unique index rejects it. A fresh
    // owner is rolled back (banned) if the branch ultimately fails to persist so
    // we never strand a login with no branch.
    let saved: Branch | undefined;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const branch = this.branches.create({
        name,
        code: generateBranchCode(name),
        region: null,
        address: dto.address.trim(),
        contactNumber: dto.contactNumber ?? null,
        province: dto.province?.trim() ? dto.province.trim() : null,
        city: dto.city?.trim() ? dto.city.trim() : null,
        status: 'active',
        ownerId: owner?.id ?? existingOwner?.id ?? null,
        sourceStoreLocationId: dto.sourceStoreLocationId ?? null,
        geofence: dto.geofence ?? null,
        createdAt: now,
        updatedAt: now,
      });

      try {
        saved = await this.branches.save(branch);
        break;
      } catch (err) {
        lastErr = err;
        const isCodeClash =
          err instanceof QueryFailedError &&
          (err as { code?: string }).code === PG_UNIQUE_VIOLATION;
        if (isCodeClash) continue; // re-roll the suffix and retry once
        break; // a different failure — stop and roll the owner back
      }
    }

    if (!saved) {
      if (owner) {
        await this.goTrue.banUser(owner.id).catch(() => undefined);
      }
      throw lastErr;
    }

    // Project the persisted UUID into the owner's protected claims. A single
    // owner can accumulate multiple branch UUIDs; the branch row retains the
    // inverse owner_id association for registry queries and audit attribution.
    let linkedOwner: { id: string; email: string | null } | null = null;
    try {
      if (existingOwner) {
        linkedOwner = await this.linkOwner(existingOwner, saved);
      } else if (owner && newOwnerMetadata) {
        await this.goTrue.updateUser(owner.id, {
          app_metadata: withBranchScope(newOwnerMetadata, [{ id: saved.id, name: saved.name }]),
        });
        linkedOwner = { id: owner.id, email: owner.email };
      }
    } catch (error) {
      // GoTrue and Postgres cannot share a transaction. Fail closed by retiring
      // the just-created branch if its protected UUID projection cannot be
      // completed; preserve the row for audit instead of hard-deleting it.
      saved.status = 'inactive';
      saved.updatedAt = new Date();
      await this.branches.save(saved).catch(() => undefined);
      if (owner) await this.goTrue.banUser(owner.id).catch(() => undefined);
      throw error;
    }

    if (linkedOwner && this.governanceAudit) {
      await this.governanceAudit.record({
        category: 'branch-owner-change',
        action: 'branch-owner-initial-assignment',
        actor: principal,
        affectedRecordType: 'branch-owner-assignment',
        affectedRecordId: saved.id,
        branchId: saved.id,
        beforeState: null,
        afterState: {
          branch: saved.name,
          ownerId: linkedOwner.id,
          ownerEmail: linkedOwner.email,
        },
        reason: 'Initial Branch Owner assignment during branch registration',
      });
    }

    return { id: saved.id, code: saved.code, owner };
  }

  /** Adds one immutable branch UUID to an existing owner's protected scope. */
  private async linkOwner(
    owner: GoTrueUser,
    branch: Pick<Branch, 'id' | 'name'>,
  ): Promise<{ id: string; email: string | null } | null> {
    const scope = await this.scopeFromMetadata(owner.app_metadata);
    if (scope.some((assigned) => assigned.id === branch.id)) {
      return { id: owner.id, email: owner.email };
    }

    await this.goTrue.updateUser(owner.id, {
      app_metadata: withBranchScope(owner.app_metadata, [...scope, branch]),
    });
    return { id: owner.id, email: owner.email };
  }

  /** Resolves UUID claims, with a legacy-name fallback used only during rollout. */
  private async scopeFromMetadata(
    metadata: Record<string, unknown> | undefined,
  ): Promise<Array<{ id: string; name: string }>> {
    const ids = metadataBranchIds(metadata);
    const names = metadataBranchNames(metadata);
    const hasUuidScope = hasMetadataBranchIds(metadata);
    const rows = hasUuidScope
      ? ids.length
        ? await this.branches.find({ where: { id: In(ids) }, select: { id: true, name: true } })
        : []
      : names.length
        ? await this.branches.find({
            where: { name: In(names) },
            select: { id: true, name: true },
          })
        : [];
    const byId = new Map(rows.map((row) => [row.id, row]));
    const byName = new Map<string, Branch[]>();
    for (const row of rows) {
      byName.set(row.name, [...(byName.get(row.name) ?? []), row]);
    }
    return hasUuidScope
      ? ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []))
      : names.flatMap((branchName) => {
          const matches = byName.get(branchName) ?? [];
          return matches.length === 1 ? matches : [];
        });
  }

  /**
   * All branches for the Franchise Registry, newest first. FA is cross-branch,
   * so no scoping is applied; both active and retired rows are returned so the
   * registry shows full history (the UI renders status).
   */
  async list(): Promise<BranchRow[]> {
    const rows = await this.branches.find({ order: { createdAt: 'DESC' } });
    return rows.map((b) => this.toRow(b));
  }

  /**
   * Returns only active branches already resolved into the authenticated Branch
   * Owner's scope by AuthGuard. The client may choose among these rows for its
   * branch selector, but it cannot supply or widen the authorization scope.
   */
  async listAssigned(principal: Principal): Promise<AssignedBranchRow[]> {
    if (principal.branchIds.length === 0) {
      throw new ForbiddenException('No active branch is assigned to this account');
    }

    const rows = await this.branches.find({
      where: { id: In(principal.branchIds), status: 'active' },
      select: { id: true, name: true, geofence: true },
      order: { name: 'ASC' },
    });

    return rows.map((branch) => ({
      id: branch.id,
      name: branch.name,
      geofence: branch.geofence,
    }));
  }

  /**
   * Edits a branch's details (Franchise Registry "Edit"). Only the fields
   * present on the DTO are touched; name/address are trimmed, and blankable
   * fields (city/province/contact) normalize an empty string to null.
   */
  async update(
    _principal: Principal,
    id: string,
    dto: UpdateBranchDto,
  ): Promise<BranchRow> {
    const branch = await this.branches.findOne({ where: { id } });
    if (!branch) throw new NotFoundException('Branch not found');

    const oldName = branch.name;

    if (dto.name !== undefined) branch.name = dto.name.trim();
    if (dto.address !== undefined) branch.address = dto.address.trim();
    if (dto.contactNumber !== undefined)
      branch.contactNumber = dto.contactNumber.trim() ? dto.contactNumber.trim() : null;
    if (dto.city !== undefined) branch.city = dto.city.trim() ? dto.city.trim() : null;
    if (dto.province !== undefined)
      branch.province = dto.province.trim() ? dto.province.trim() : null;
    if (dto.geofence !== undefined) branch.geofence = dto.geofence ?? null;
    branch.updatedAt = new Date();

    const saved = await this.branches.save(branch);

    // UUID scope survives renames. Refresh display-only branch labels for users
    // assigned to this UUID; legacy-name accounts are included during rollout.
    if (saved.name !== oldName) {
      const users = await this.goTrue.listUsers();
      for (const u of users) {
        const ids = metadataBranchIds(u.app_metadata);
        const legacyNames = metadataBranchNames(u.app_metadata);
        if (!ids.includes(saved.id) && !legacyNames.includes(oldName)) continue;
        const resolved = await this.scopeFromMetadata(u.app_metadata);
        const scope = resolved.some((assigned) => assigned.id === saved.id)
          ? resolved
          : [...resolved, { id: saved.id, name: saved.name }];
        await this.goTrue.updateUser(u.id, {
          app_metadata: withBranchScope(u.app_metadata, scope),
        });
      }
    }

    return this.toRow(saved);
  }

  /**
   * Soft-delete: retire a branch by flipping it inactive. Never a hard delete —
   * the row is kept for history (AGENTS.md §3.2). Idempotent if already inactive.
   */
  async deactivate(_principal: Principal, id: string): Promise<BranchRow> {
    const branch = await this.branches.findOne({ where: { id } });
    if (!branch) throw new NotFoundException('Branch not found');

    branch.status = 'inactive';
    branch.updatedAt = new Date();

    const saved = await this.branches.save(branch);
    return this.toRow(saved);
  }

  private toRow(b: Branch): BranchRow {
    return {
      id: b.id,
      name: b.name,
      code: b.code,
      status: b.status,
      province: b.province,
      city: b.city,
      address: b.address,
      contact_number: b.contactNumber,
      geofence: b.geofence,
      source_store_location_id: b.sourceStoreLocationId,
      owner_id: b.ownerId,
      created_at: b.createdAt,
    };
  }
}
