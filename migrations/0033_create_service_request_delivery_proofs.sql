-- Proof of Delivery metadata for the SRD module.
-- Image bytes are kept in a private object-storage bucket; PostgreSQL stores
-- only metadata and the provider-neutral object key. No foreign keys are used
-- in this schema; the NestJS service validates logical references.

CREATE SCHEMA IF NOT EXISTS srd;

CREATE TABLE IF NOT EXISTS srd.service_request_delivery_proofs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_request_id  uuid        NOT NULL,
  branch_id           uuid        NOT NULL,
  rider_id            uuid        NOT NULL,
  storage_path        text        NOT NULL,
  original_file_name  text        NOT NULL,
  mime_type           text        NOT NULL,
  byte_size           integer     NOT NULL,
  sha256              text        NOT NULL,
  uploaded_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz
);

CREATE INDEX IF NOT EXISTS service_request_delivery_proofs_service_request_id_idx
  ON srd.service_request_delivery_proofs (service_request_id);

CREATE INDEX IF NOT EXISTS service_request_delivery_proofs_branch_id_idx
  ON srd.service_request_delivery_proofs (branch_id);

CREATE INDEX IF NOT EXISTS service_request_delivery_proofs_rider_id_idx
  ON srd.service_request_delivery_proofs (rider_id);

CREATE INDEX IF NOT EXISTS service_request_delivery_proofs_deleted_at_idx
  ON srd.service_request_delivery_proofs (deleted_at);

CREATE UNIQUE INDEX IF NOT EXISTS service_request_delivery_proofs_one_live_per_request_idx
  ON srd.service_request_delivery_proofs (service_request_id)
  WHERE deleted_at IS NULL;
