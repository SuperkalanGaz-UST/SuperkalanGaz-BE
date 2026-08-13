-- 0014_create_lpg_product_catalog.sql
-- Stores the shared, system-wide LPG retail catalog confirmed for FA, BO, BM,
-- and customer use. New Service Requests snapshot the effective price so later
-- catalog changes never rewrite historical order amounts.
-- Apply via the Supabase SQL editor.

CREATE SCHEMA IF NOT EXISTS srd;

CREATE TABLE IF NOT EXISTS srd.products (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text           NOT NULL,
  sku               text,
  cylinder_size_kg  numeric(5, 1),
  base_price        numeric(10, 2),
  is_active         boolean        NOT NULL DEFAULT true,
  created_at        timestamptz    NOT NULL DEFAULT now(),
  updated_at        timestamptz    NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS products_cylinder_size_kg_unique_idx
  ON srd.products (cylinder_size_kg);

CREATE UNIQUE INDEX IF NOT EXISTS products_sku_unique_idx
  ON srd.products (sku);

CREATE INDEX IF NOT EXISTS products_is_active_idx
  ON srd.products (is_active);

INSERT INTO srd.products (name, sku, cylinder_size_kg, base_price, is_active)
VALUES
  ('50kg LPG Cylinder',  'LPG-50KG',  50.0, 1500.00, true),
  ('22kg LPG Cylinder',  'LPG-22KG',  22.0, 1100.00, true),
  ('11kg LPG Cylinder',  'LPG-11KG',  11.0,  650.00, true),
  ('5kg LPG Cylinder',   'LPG-5KG',    5.0,  350.00, true),
  ('2.7kg LPG Cylinder', 'LPG-2.7KG',  2.7,  200.00, true)
ON CONFLICT (cylinder_size_kg) DO NOTHING;

ALTER TABLE srd.service_requests
  ADD COLUMN IF NOT EXISTS unit_price numeric(10, 2),
  ADD COLUMN IF NOT EXISTS total_amount numeric(12, 2);

-- Best-effort backfill for legacy rows whose free-text cylinder size matches
-- the new canonical catalog. Both columns remain nullable for unmatched legacy
-- data; all new requests are populated by the API.
UPDATE srd.service_requests AS request
SET
  unit_price = product.base_price,
  total_amount = product.base_price * request.quantity
FROM srd.products AS product
WHERE request.unit_price IS NULL
  AND lower(replace(request.cylinder_size, ' ', '')) =
    CASE
      WHEN product.cylinder_size_kg = trunc(product.cylinder_size_kg)
        THEN trunc(product.cylinder_size_kg)::integer::text
      ELSE product.cylinder_size_kg::text
    END || 'kg';
