-- 0005_drop_branch_review_columns.sql
-- Removes the Franchise Admin branch "review" feature from core.branches.
--
-- The review endpoint (PATCH /branches/:id/review) and its DTO have been removed
-- from the API, and the Franchise Registry UI no longer surfaces flag/clear — so
-- these four columns are dead. Dropping `review_status` also drops its column
-- CHECK constraint ('none' | 'flagged' | 'cleared') automatically. Irreversible
-- (any stored review history is discarded). Apply via the Supabase SQL editor.

ALTER TABLE core.branches
  DROP COLUMN IF EXISTS review_status,
  DROP COLUMN IF EXISTS review_note,
  DROP COLUMN IF EXISTS reviewed_by,
  DROP COLUMN IF EXISTS reviewed_at;
