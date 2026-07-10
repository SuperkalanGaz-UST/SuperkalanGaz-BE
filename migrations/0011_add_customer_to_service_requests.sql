-- 0011_add_customer_to_service_requests.sql
-- Links a Service Request to a CIM customer profile (stories BM-029..BM-032). At
-- intake the Branch Manager may search + select (or register + select) a customer
-- and file the order against them; this column records that link.
--
-- ADDITIVE and non-breaking: the column is NULLABLE, so existing rows keep
-- customer_id = NULL and walk-in intake without a linked customer still works
-- exactly as before (story BM-005 / Slice 1 behavior is unchanged). The
-- denormalized customer_name / customer_contact / delivery_address columns stay
-- as-is — they remain the order's point-in-time snapshot even when a profile is
-- linked. No FK by design (AGENTS.md §6) — the service layer validates the
-- customer exists, is live, and belongs to the SAME branch as the request before
-- persisting. Apply via the Supabase SQL editor.

ALTER TABLE srd.service_requests
  ADD COLUMN IF NOT EXISTS customer_id uuid;

-- customer_id is a logical FK / lookup column (which customer this order is for),
-- so it gets its own index in the same migration that introduces it (AGENTS.md
-- §6). It also backs the customer "last order date" aggregate in the CIM search.
CREATE INDEX IF NOT EXISTS service_requests_customer_id_idx
  ON srd.service_requests (customer_id);
