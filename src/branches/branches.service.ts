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
import { Branch } from './branch.entity';
import { CreateBranchDto } from './dto/create-branch.dto';
import { ReviewBranchDto } from './dto/review-branch.dto';

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
  review_status: 'none' | 'flagged' | 'cleared';
  review_note: string | null;
  reviewed_at: Date | null;
  province: string | null;
  city: string | null;
  address: string | null;
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

    // "New owner" path: create a real Branch Owner login. The
    // on_auth_user_created trigger mirrors the metadata into public.profiles,
    // which is where the API reads role + branch membership from. Owner identity
    // is NOT stored on core.branches (it has no owner columns).
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
        user_metadata: {
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
        reviewStatus: 'none',
        reviewNote: null,
        reviewedBy: null,
        reviewedAt: null,
        sourceStoreLocationId: dto.sourceStoreLocationId ?? null,
        createdAt: now,
        updatedAt: now,
      });

      try {
        const saved = await this.branches.save(branch);
        return { id: saved.id, code: saved.code, owner };
      } catch (err) {
        lastErr = err;
        const isCodeClash =
          err instanceof QueryFailedError &&
          (err as { code?: string }).code === PG_UNIQUE_VIOLATION;
        if (isCodeClash) continue; // re-roll the suffix and retry once
        break; // a different failure — stop and roll the owner back
      }
    }

    if (owner) {
      await this.goTrue.banUser(owner.id).catch(() => undefined);
    }
    throw lastErr;
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
   * Records a Franchise Admin review decision on a branch, stamping who acted
   * and when. 'flag' → flagged (with optional note); 'clear' → cleared.
   */
  async review(
    principal: Principal,
    id: string,
    dto: ReviewBranchDto,
  ): Promise<BranchRow> {
    const branch = await this.branches.findOne({ where: { id } });
    if (!branch) throw new NotFoundException('Branch not found');

    branch.reviewStatus = dto.action === 'flag' ? 'flagged' : 'cleared';
    branch.reviewNote = dto.note?.trim() ? dto.note.trim() : null;
    branch.reviewedBy = principal.userId;
    branch.reviewedAt = new Date();
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
      review_status: b.reviewStatus,
      review_note: b.reviewNote,
      reviewed_at: b.reviewedAt,
      province: b.province,
      city: b.city,
      address: b.address,
      source_store_location_id: b.sourceStoreLocationId,
      created_at: b.createdAt,
    };
  }
}
