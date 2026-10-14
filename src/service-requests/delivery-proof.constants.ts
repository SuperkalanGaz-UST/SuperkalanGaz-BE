/**
 * Temporary storage decision: Supabase Storage is used behind the NestJS API
 * until a separately approved private object-storage provider is available.
 * Clients never receive the service key or access the bucket directly.
 */
export const DELIVERY_PROOF_BUCKET = 'delivery-proofs';
export const DELIVERY_PROOF_MAX_BYTES = 3 * 1024 * 1024;
export const DELIVERY_PROOF_ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
] as const;

export type DeliveryProofMimeType =
  (typeof DELIVERY_PROOF_ALLOWED_MIME_TYPES)[number];

export function isDeliveryProofMimeType(
  value: string,
): value is DeliveryProofMimeType {
  return (DELIVERY_PROOF_ALLOWED_MIME_TYPES as readonly string[]).includes(value);
}
