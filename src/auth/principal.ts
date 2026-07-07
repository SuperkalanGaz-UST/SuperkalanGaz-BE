/** Roles recognized by the CRM (mirrors the check constraint on public.profiles.role). */
export type Role = 'franchise-admin' | 'branch-owner' | 'branch-manager';

/**
 * The authenticated caller, derived entirely from the verified JWT and the
 * caller's own profiles row — never from request params or body. All branch
 * scoping decisions flow from this object (AGENTS.md §5).
 */
export interface Principal {
  userId: string;
  role: Role;
  /**
   * Branch NAMES this caller belongs to — the tenancy handle stored on
   * public.profiles. Kept for name-based scoping (e.g. the Users module) and
   * display. FA semantics: cross-branch read visibility.
   */
  branches: string[];
  /**
   * The same branches resolved to their public.branches UUIDs, computed once by
   * AuthGuard. Domain tables (SRD/LPM/CSAT/Fleet/CIM) scope by branch_id, so
   * scope those queries by this — not by name (AGENTS.md §5, §6). A name that no
   * longer maps to a live branch is dropped, so this fails closed.
   */
  branchIds: string[];
}

/** Key under which the guard stashes the principal on the Express request. */
export const REQUEST_PRINCIPAL = 'principal';
