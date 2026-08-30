/** UUID validation used for protected branch-scope claims. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(value.filter((item): item is string => typeof item === 'string' && item !== '')),
  );
}

/** Authoritative UUID tenancy scope from service-role-only app_metadata. */
export function metadataBranchIds(metadata: Record<string, unknown> | undefined): string[] {
  return uniqueStrings(metadata?.branch_ids).filter((id) => UUID_PATTERN.test(id));
}

/** Presence matters: an explicit empty UUID scope must fail closed, not fall back. */
export function hasMetadataBranchIds(
  metadata: Record<string, unknown> | undefined,
): boolean {
  return Array.isArray(metadata?.branch_ids);
}

/**
 * Display-only branch labels. These remain during the UUID rollout so current
 * clients can render names, but guards must never authorize from them when a
 * branch_ids claim exists.
 */
export function metadataBranchNames(
  metadata: Record<string, unknown> | undefined,
): string[] {
  return uniqueStrings(metadata?.branches);
}

/** Keeps UUID authorization and display labels aligned in protected metadata. */
export function withBranchScope(
  metadata: Record<string, unknown> | undefined,
  branches: ReadonlyArray<{ id: string; name: string }>,
): Record<string, unknown> {
  return {
    ...(metadata ?? {}),
    branch_ids: branches.map((branch) => branch.id),
    branches: branches.map((branch) => branch.name),
  };
}
