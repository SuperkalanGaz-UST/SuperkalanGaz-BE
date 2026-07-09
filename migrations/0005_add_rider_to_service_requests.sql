-- 0005_add_rider_to_service_requests.sql
-- Adds the rider assignment to srd.service_requests for the dispatch action
-- (story BM-004). On dispatch the service sets rider_id alongside dispatched_at
-- and status='Dispatched' (the request→dispatch leg of the four-timestamp SLA
-- chain, AGENTS.md §8.2). Manual dispatch only — no in_transit_at / "En Route"
-- transition here; that is GPS/hardware-dependent and deferred (AGENTS.md §8).
--
-- New nullable column: existing rows keep rider_id = NULL (they were created
-- pre-dispatch). No FK by design (AGENTS.md §6) — the service layer validates
-- the rider exists, is live, is Available, and belongs to the SAME branch as the
-- request before persisting. Apply via the Supabase SQL editor.

ALTER TABLE srd.service_requests
  ADD COLUMN IF NOT EXISTS rider_id uuid;

-- rider_id is a logical FK / lookup column (which rider is on this order), so it
-- gets its own index in the same migration that introduces it (AGENTS.md §6).
CREATE INDEX IF NOT EXISTS service_requests_rider_id_idx
  ON srd.service_requests (rider_id);
