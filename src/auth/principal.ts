/** Roles recognized by the CRM (carried in the auth user's app_metadata.role). */
export const ROLES = [
  'super-admin',
  'franchise-admin',
  'branch-owner',
  'branch-manager',
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
  /**
   * Branch NAMES this caller belongs to — the tenancy handle carried in the
   * JWT's app_metadata.branches. Kept for name-based scoping (e.g. the Users
   * module) and display. FA semantics: cross-branch read visibility.
   */
  branches: string[];
  /**
   * The same branches resolved to their core.branches UUIDs, computed once by
   * AuthGuard. Domain tables (SRD/LPM/CSAT/Fleet/CIM) scope by branch_id, so
   * scope those queries by this — not by name (AGENTS.md §5, §6). A name that no
   * longer maps to a live branch is dropped, so this fails closed. SA/FA use
   * cross-branch semantics and therefore normally carry no branch list.
   */
  branchIds: string[];
}

/** Key under which the guard stashes the principal on the Express request. */
export const REQUEST_PRINCIPAL = 'principal';
