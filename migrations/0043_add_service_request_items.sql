-- A Service Request keeps one set of payment, dispatch, and SLA milestones.
-- Existing records keep their single-cylinder snapshot in the original columns.
ALTER TABLE srd.service_requests ADD COLUMN IF NOT EXISTS items jsonb;
