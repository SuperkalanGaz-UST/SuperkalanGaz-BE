-- Region price lists supplement the shared catalog; no existing price or order is rewritten.
BEGIN;
CREATE TABLE IF NOT EXISTS srd.regional_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  region_code text NOT NULL CHECK (region_code IN
    ('NCR', 'CAR', 'I', 'II', 'III', 'IV-A', 'MIMAROPA', 'V', 'VI', 'VII',
     'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'NIR', 'BARMM')),
  product_id uuid NOT NULL,
  unit_price numeric(10,2) NOT NULL CHECK (unit_price > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS regional_prices_region_product_uq
  ON srd.regional_prices(region_code, product_id);
CREATE INDEX IF NOT EXISTS regional_prices_product_id_idx ON srd.regional_prices(product_id);
CREATE INDEX IF NOT EXISTS branches_region_idx ON core.branches(region);
COMMENT ON COLUMN core.branches.region IS
  'Server-validated Philippine region code for pricing; null retains system-wide defaults.';
COMMIT;
