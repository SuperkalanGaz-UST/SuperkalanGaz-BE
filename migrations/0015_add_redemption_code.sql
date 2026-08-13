-- 0015_add_redemption_code.sql
-- Adds the system-generated redemption code issued when a Branch Manager approves
-- a loyalty redemption (stories BM-016 / BM-017, journey BM-US-03). On approval the
-- service generates a unique RDM-XXXXXXXX code, persists it here, and returns it;
-- the Branch Manager never types a code (it is system-generated). The customer-side
-- in-app delivery of the code (CU-013/014) is out of Branch Manager scope — this
-- column is the persisted source the customer app reads.
--
-- ADDITIVE and non-breaking: the column is NULLABLE, so every existing redemption
-- keeps redemption_code = NULL. Only approved (or auto-issued) redemptions carry a
-- code; pending / rejected / cancelled rows stay NULL. No FK involved.
--
-- Apply via the Supabase SQL editor.

ALTER TABLE loyalty.redemptions
  ADD COLUMN IF NOT EXISTS redemption_code text;

-- Codes must be globally unique so a code identifies exactly one redemption, but
-- only among rows that HAVE one — a partial unique index lets the many NULL
-- (unissued) rows coexist while still guaranteeing issued-code uniqueness. The
-- service also uses this index to detect (and retry on) the rare generation clash.
CREATE UNIQUE INDEX IF NOT EXISTS redemptions_redemption_code_key
  ON loyalty.redemptions (redemption_code)
  WHERE redemption_code IS NOT NULL;
