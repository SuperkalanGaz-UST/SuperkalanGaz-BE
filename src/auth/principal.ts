/** Roles recognized by the CRM (carried in the auth user's app_metadata.role). */
export const ROLES = [
  'super-admin',
  'franchise-admin',
  'branch-owner',
  'branch-manager',
  'driver',
  'customer',
] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && ROLES.includes(value as Role);
}

/**
 * The authenticated caller, derived entirely from the verified JWT's
 * app_metadata claims — never from request params or body. All branch scoping
 * decisions flow from this object (AGENTS.md §5).
 */
export interface Principal {
  userId: string;
  role: Role;
  /** Self-service identity fields copied from the verified token, never request input. */
  email?: string | null;
  username?: string | null;
  displayName?: string | null;
  phone?: string | null;
  status?: 'Active' | 'Inactive' | 'Pending';
  /** Customer loyalty classification from protected app_metadata. */
  accountType?: 'household' | 'commercial';
  /** Live branch names resolved by AuthGuard for display only. */
  branches: string[];
  /**
   * Authoritative live branch UUID scope from app_metadata.branch_ids, validated
   * against core.branches by AuthGuard. A Branch Owner may have one or more;
   * a Branch Manager must have exactly one. Domain queries scope by these UUIDs,
   * never by editable branch names (AGENTS.md §5, §6).
   */
  branchIds: string[];
}

/** Key under which the guard stashes the principal on the Express request. */
export const REQUEST_PRINCIPAL = 'principal';
