-- 0018_add_rating_resolution.sql
-- Adds closed-loop resolution tracking to CSAT ratings (journey BM-US-08, stories
-- BM-040/BM-041). A low-star rating starts life unaddressed; the Branch Manager
-- logs a resolution note and marks it Resolved, which is what decrements the
-- branch's "Open Complaints" KPI and what the Franchise Admin sees in the
-- cross-branch CSAT overview (FA-US-04).
--
-- ADDITIVE and non-breaking: resolution_status defaults to 'Open', so every
-- existing and future rating starts unaddressed with no backfill required. NOT
-- NULL is safe precisely because of that default. The remaining three columns are
-- nullable — they are only populated once a BM resolves the entry. No FK by design
-- (AGENTS.md §6); resolved_by is the acting BM's auth user id, validated in the
-- service layer.
--
-- Apply via the Supabase SQL editor.

ALTER TABLE csat.ratings
  ADD COLUMN IF NOT EXISTS resolution_status text NOT NULL DEFAULT 'Open',
  ADD COLUMN IF NOT EXISTS resolution_note text,
  ADD COLUMN IF NOT EXISTS resolved_by uuid,
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz;

-- Constrain the lifecycle to the two states this journey defines. Guarded so a
-- re-run does not error on an already-constrained table.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ratings_resolution_status_check'
  ) THEN
    ALTER TABLE csat.ratings
      ADD CONSTRAINT ratings_resolution_status_check
      CHECK (resolution_status IN ('Open', 'Resolved'));
  END IF;
END $$;

-- The Branch Manager's CSAT queue filters by (branch, resolution_status) and
-- sorts the low-star entries, so index the lookup columns it drives (AGENTS.md §6).
CREATE INDEX IF NOT EXISTS ratings_branch_resolution_idx
  ON csat.ratings (branch_id, resolution_status);

CREATE INDEX IF NOT EXISTS ratings_service_request_id_idx
  ON csat.ratings (service_request_id);
