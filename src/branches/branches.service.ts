import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'crypto';
import { QueryFailedError, Repository } from 'typeorm';
import { Principal } from '../auth/principal';
import { GoTrueAdminService } from '../users/gotrue-admin.service';
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
  created_at: Date;
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
  ) {}

  async create(_principal: Principal, dto: CreateBranchDto): Promise<CreateBranchResult> {
    const name = dto.name.trim();

    // "New owner" path: create a real Branch Owner login. Role + branch
    // membership are written to the auth user's app_metadata (service-role-only),
    // which is where the API reads them from — there is no profiles table. Owner
    // identity is NOT stored on core.branches (it has no owner columns).
    let owner: ProvisionedOwner | null = null;
    if (dto.ownerType === 'new') {
      if (!dto.ownerEmail || !dto.ownerName) {
        throw new BadRequestException('A new owner requires a name and email address');
      }
      const tempPassword = generateTempPassword();
      const { id } = await this.goTrue.createUser({
        email: dto.ownerEmail,
        password: tempPassword,
        email_confirm: true,
        app_metadata: {
          username: dto.ownerEmail.split('@')[0],
          display_name: dto.ownerName,
          role: 'branch-owner',
          branches: [name],
          phone: dto.ownerMobile ?? null,
          status: 'Active',
        },
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

    // "Existing owner" path: the branch persisted, so grant that owner access by
    // adding this branch to their profile. Without this the branch has no linked
    // owner and the Edit screen reports "No Branch Owner is linked to this
    // branch". (The "new owner" path already seeded its branch via GoTrue
    // metadata above.) Kept out of the retry loop so a link failure never trips
    // the branch-code re-roll.
    if (dto.ownerType === 'existing') {
      await this.linkExistingOwner(dto, saved.name);
    }

    return { id: saved.id, code: saved.code, owner };
  }

  /**
   * Adds `branchName` to the selected existing owner's branch scope so they gain
   * Branch Owner access to it (tenancy is keyed by branch name in the auth user's
   * app_metadata.branches — AGENTS.md §5). Idempotent: the branch is appended
   * only when not already present, preserving the existing order. The owner is
   * matched by id when supplied (the integrity boundary), else by email as a
   * fallback for older clients. A no-op if neither identifier resolves a user.
   */
  private async linkExistingOwner(
    dto: CreateBranchDto,
    branchName: string,
  ): Promise<void> {
    const owner = dto.ownerId
      ? await this.goTrue.getUser(dto.ownerId)
      : dto.ownerEmail
        ? await this.goTrue.findByEmail(dto.ownerEmail)
        : null;
    if (!owner) return; // nothing to match on / owner not found — leave auth untouched

    const meta = owner.app_metadata ?? {};
    const branches = Array.isArray(meta.branches)
      ? (meta.branches as unknown[]).filter((b): b is string => typeof b === 'string')
      : [];
    if (branches.includes(branchName)) return; // idempotent

    await this.goTrue.updateUser(owner.id, {
      app_metadata: { ...meta, branches: [...branches, branchName] },
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

    // Tenancy is keyed by branch NAME in each user's app_metadata.branches
    // (AGENTS.md §5), so a rename must cascade to every user (owners and
    // managers) referencing the old name — otherwise they silently lose access
    // to the renamed branch. No profiles table to UPDATE now, so we page the
    // auth users and patch the ones that reference it.
    if (saved.name !== oldName) {
      const users = await this.goTrue.listUsers();
      for (const u of users) {
        const meta = u.app_metadata ?? {};
        const branches = Array.isArray(meta.branches)
          ? (meta.branches as unknown[]).filter((b): b is string => typeof b === 'string')
          : [];
        if (!branches.includes(oldName)) continue;
        await this.goTrue.updateUser(u.id, {
          app_metadata: {
            ...meta,
            branches: branches.map((b) => (b === oldName ? saved.name : b)),
          },
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
      created_at: b.createdAt,
    };
  }
}
