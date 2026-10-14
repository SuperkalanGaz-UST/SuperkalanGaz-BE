-- 0029_add_customer_track_codes.sql
-- Human-readable customer IDs, sequential per loyalty track: H-00001 for
-- household, C-00001 for commercial. account_type is set once at creation
-- and never changed afterwards, so a BEFORE INSERT trigger is sufficient —
-- no UPDATE case to handle.

CREATE SEQUENCE IF NOT EXISTS cim.household_customer_code_seq START 1;
CREATE SEQUENCE IF NOT EXISTS cim.commercial_customer_code_seq START 1;

ALTER TABLE cim.customers
  ADD COLUMN IF NOT EXISTS customer_code text;

-- Backfill existing rows deterministically (oldest first) per track.
WITH ordered AS (
  SELECT id, account_type,
         row_number() OVER (PARTITION BY account_type ORDER BY created_at, id) AS rn
  FROM cim.customers
  WHERE customer_code IS NULL
)
UPDATE cim.customers c
SET customer_code = (CASE WHEN o.account_type = 'household' THEN 'H-' ELSE 'C-' END)
  || lpad(o.rn::text, 5, '0')
FROM ordered o
WHERE c.id = o.id;

-- Advance each sequence past the backfilled range so the trigger below
-- continues numbering without collisions.
SELECT setval('cim.household_customer_code_seq',
  GREATEST(1, (SELECT count(*) FROM cim.customers WHERE account_type = 'household')), true);
SELECT setval('cim.commercial_customer_code_seq',
  GREATEST(1, (SELECT count(*) FROM cim.customers WHERE account_type = 'commercial')), true);

CREATE UNIQUE INDEX IF NOT EXISTS customers_customer_code_uidx
  ON cim.customers (customer_code);

CREATE OR REPLACE FUNCTION cim.assign_customer_code()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.customer_code IS NULL THEN
    IF NEW.account_type = 'commercial' THEN
      NEW.customer_code := 'C-' || lpad(nextval('cim.commercial_customer_code_seq')::text, 5, '0');
    ELSE
      NEW.customer_code := 'H-' || lpad(nextval('cim.household_customer_code_seq')::text, 5, '0');
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS customers_assign_code ON cim.customers;
CREATE TRIGGER customers_assign_code
BEFORE INSERT ON cim.customers
FOR EACH ROW EXECUTE FUNCTION cim.assign_customer_code();
