/**
 * Shared normalization for the optional vehicle label. Collapsing whitespace
 * keeps "Red  Yamaha" and "Red Yamaha" identical; an empty string clears the
 * label so the card falls back to the plate number.
 */
export function normalizeVehicleDisplayName(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  return trimmed === '' ? null : trimmed;
}

export const VEHICLE_DISPLAY_NAME_MAX_LENGTH = 60;
