import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'crypto';
import { IsNull, QueryFailedError, Repository } from 'typeorm';
import { Principal } from '../auth/principal';
import { GoTrueAdminService } from '../users/gotrue-admin.service';
import { Branch } from './branch.entity';
import { CreateBranchDto } from './dto/create-branch.dto';

/** Postgres unique_violation — raised by the partial unique index on name. */
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
  owner: ProvisionedOwner | null;
}

/** URL-safe temp password; 16 chars easily clears Supabase's default policy. */
function generateTempPassword(): string {
  return randomBytes(12).toString('base64url');
}

/**
 * Branch registry. Only Franchise Admins reach this (enforced at the
 * controller); FA is cross-branch, so there is no per-branch scope check on
 * create. Soft delete only (AGENTS.md §3.2) — no hard deletes here.
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

    // Fail fast on a duplicate name BEFORE we provision any auth user, so the
    // common "name taken" case never leaves an orphaned owner account behind.
    const clash = await this.branches.findOne({ where: { name, deletedAt: IsNull() } });
    if (clash) throw new ConflictException(`A branch named "${name}" already exists`);

    // "New owner" path: create a real Branch Owner login scoped to this branch.
    // The on_auth_user_created trigger mirrors the metadata into public.profiles.
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
    const branch = this.branches.create({
      name,
      contactNumber: dto.contactNumber ?? null,
      address: dto.address.trim(),
      city: dto.city.trim(),
      province: dto.province.trim(),
      lowStockThreshold: dto.lowStockThreshold ?? 20,
      ownerType: dto.ownerType ?? null,
      ownerName: dto.ownerName ?? null,
      ownerEmail: dto.ownerEmail ?? null,
      ownerId: owner?.id ?? null,
      geofence: dto.geofence ?? null,
      curfewStart: dto.curfewStart ?? null,
      curfewEnd: dto.curfewEnd ?? null,
      status: 'Active',
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });

    try {
      const saved = await this.branches.save(branch);
      return { id: saved.id, owner };
    } catch (err) {
      // Roll back a just-provisioned owner so a failed insert (e.g. a name-race
      // that beat the pre-check) doesn't leave a login with no branch.
      if (owner) {
        await this.goTrue.banUser(owner.id).catch(() => undefined);
      }
      if (
        err instanceof QueryFailedError &&
        (err as { code?: string }).code === PG_UNIQUE_VIOLATION
      ) {
        throw new ConflictException(`A branch named "${name}" already exists`);
      }
      throw err;
    }
  }
}
