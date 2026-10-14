import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Metadata for the single Proof of Delivery associated with a Service Request.
 * The image bytes remain in private object storage; this table deliberately
 * stores only lookup, integrity, and audit metadata (AGENTS.md §6).
 *
 * There are no database foreign keys by design. The Service Request service
 * validates the parent request, branch, and authenticated Delivery Rider.
 */
@Entity({ schema: 'srd', name: 'service_request_delivery_proofs' })
export class ServiceRequestDeliveryProof {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'service_request_id', type: 'uuid' })
  serviceRequestId!: string;

  @Column({ name: 'branch_id', type: 'uuid' })
  branchId!: string;

  @Column({ name: 'rider_id', type: 'uuid' })
  riderId!: string;

  /** Provider-neutral object key; never a public URL. */
  @Column({ name: 'storage_path', type: 'text' })
  storagePath!: string;

  @Column({ name: 'original_file_name', type: 'text' })
  originalFileName!: string;

  @Column({ name: 'mime_type', type: 'text' })
  mimeType!: string;

  @Column({ name: 'byte_size', type: 'integer' })
  byteSize!: number;

  @Column({ name: 'sha256', type: 'text' })
  sha256!: string;

  @Column({ name: 'uploaded_at', type: 'timestamptz' })
  uploadedAt!: Date;

  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}
