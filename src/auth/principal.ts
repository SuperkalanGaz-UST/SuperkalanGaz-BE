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
  /** Branches this caller belongs to. FA semantics: cross-branch read visibility. */
  branches: string[];
}

/** Key under which the guard stashes the principal on the Express request. */
export const REQUEST_PRINCIPAL = 'principal';
