-- 0029_index_branch_owner_assignment.sql
-- Formalizes the one-owner-to-many-branches association already represented by
-- core.branches.owner_id. Multiple branch rows may reference the same auth.users
-- UUID; each branch row has at most one active owner. No FK is added because CRM
-- referential integrity is enforced by NestJS services (AGENTS.md §6).

ALTER TABLE core.branches
  ADD COLUMN IF NOT EXISTS owner_id uuid;

CREATE INDEX IF NOT EXISTS branches_owner_id_idx
  ON core.branches (owner_id);
