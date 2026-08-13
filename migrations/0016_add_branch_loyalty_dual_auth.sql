-- 0016_add_branch_loyalty_dual_auth.sql
-- Adds the per-branch Dual Authorization setting for loyalty redemptions (story
-- BM-013, journey BM-US-03). When ON (the default), customer redemption requests
-- enter the Branch Manager's pending Rewards Claiming queue for manual approve /
-- reject. When OFF, the branch has delegated issuance: a request is auto-approved
-- and its code issued immediately, so it never appears in the queue.
--
-- ADDITIVE and non-breaking: DEFAULT true means every existing branch keeps the
-- dual-authorization behavior already built (the approval queue) with no data
-- backfill and no behavior change. NOT NULL is safe precisely because of the
-- default. Setting lives on the branch (per BM-013's "Branch Settings").
--
-- Apply via the Supabase SQL editor.

ALTER TABLE core.branches
  ADD COLUMN IF NOT EXISTS loyalty_dual_auth boolean NOT NULL DEFAULT true;
