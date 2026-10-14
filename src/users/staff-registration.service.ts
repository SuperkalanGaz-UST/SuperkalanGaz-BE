import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DecideStaffRegistrationDto } from './dto/decide-staff-registration.dto';
import { ListStaffRegistrationsQuery } from './dto/list-staff-registrations.query';
import { GoTrueAdminService, GoTrueUser } from './gotrue-admin.service';

type ReviewableRole = 'branch-owner' | 'branch-manager';

export interface StaffRegistrationRequestRow {
  id: string;
  role: ReviewableRole;
  status: 'pending';
  applicant_name: string;
  applicant_email: string;
  applicant_phone: string | null;
  branch_name: string | null;
  branch_address: null;
  submitted_at: string;
  decided_by_name: null;
  decision_reason: null;
}

function metadataString(user: GoTrueUser, key: string): string | null {
  const value = user.app_metadata?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function metadataBranches(user: GoTrueUser): string[] {
  const value = user.app_metadata?.branches;
  return Array.isArray(value)
    ? value.filter((branch): branch is string => typeof branch === 'string' && branch !== '')
    : [];
}

function isReviewableRole(value: unknown): value is ReviewableRole {
  return value === 'branch-owner' || value === 'branch-manager';
}

function isBanned(user: GoTrueUser): boolean {
  return Boolean(
    user.banned_until && new Date(user.banned_until).getTime() > Date.now(),
  );
}

function submittedAt(user: GoTrueUser): string {
  const submitted = metadataString(user, 'registration_submitted_at');
  if (submitted && Number.isFinite(new Date(submitted).getTime())) return submitted;
  return user.created_at;
}

/**
 * Read-only bridge for the Account Reviews tab. Pending staff identity is
 * sourced from protected Supabase Auth app_metadata, never client input. The
 * current system has no approved secure document store, so document reads are
 * explicitly empty and decisions fail closed instead of fabricating evidence.
 */
@Injectable()
export class StaffRegistrationService {
  constructor(private readonly goTrue: GoTrueAdminService) {}

  async list(
    query: ListStaffRegistrationsQuery,
  ): Promise<StaffRegistrationRequestRow[]> {
    const requestedRoles = new Set<ReviewableRole>(
      query.roles
        ? query.roles.split(',').filter(isReviewableRole)
        : ['branch-owner', 'branch-manager'],
    );

    return (await this.goTrue.listUsers())
      .filter((user) => !isBanned(user))
      .filter((user) => user.app_metadata?.status === 'Pending')
      .filter((user) => requestedRoles.has(user.app_metadata?.role as ReviewableRole))
      .map((user) => this.toRow(user))
      .sort(
        (left, right) =>
          new Date(right.submitted_at).getTime() - new Date(left.submitted_at).getTime(),
      );
  }

  async documents(id: string): Promise<[]> {
    await this.findPending(id);
    // Secure registration-document storage is not configured. Returning the
    // authoritative empty set keeps the UI connected while preventing approval.
    return [];
  }

  async decide(id: string, dto: DecideStaffRegistrationDto): Promise<never> {
    void dto;
    await this.findPending(id);
    throw new ConflictException(
      'Account decisions require secure registration documents, which are not configured',
    );
  }

  async documentContent(id: string, documentId: string): Promise<never> {
    void documentId;
    await this.findPending(id);
    throw new NotFoundException('Registration document not found');
  }

  private async findPending(id: string): Promise<GoTrueUser> {
    const user = await this.goTrue.getUser(id);
    if (
      !user ||
      isBanned(user) ||
      user.app_metadata?.status !== 'Pending' ||
      !isReviewableRole(user.app_metadata?.role)
    ) {
      throw new NotFoundException('Staff registration request not found');
    }
    return user;
  }

  private toRow(user: GoTrueUser): StaffRegistrationRequestRow {
    const role = user.app_metadata?.role;
    if (!isReviewableRole(role)) {
      // All callers filter before projection. Retaining this guard prevents a
      // future refactor from widening the review queue accidentally.
      throw new NotFoundException('Staff registration request not found');
    }
    const email = user.email ?? '';
    const name =
      metadataString(user, 'display_name') ??
      metadataString(user, 'username') ??
      email;

    return {
      id: user.id,
      role,
      status: 'pending',
      applicant_name: name,
      applicant_email: email,
      applicant_phone: metadataString(user, 'phone'),
      branch_name: metadataBranches(user)[0] ?? null,
      branch_address: null,
      submitted_at: submittedAt(user),
      decided_by_name: null,
      decision_reason: null,
    };
  }
}
