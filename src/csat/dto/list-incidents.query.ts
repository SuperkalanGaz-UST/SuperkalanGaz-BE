import { IsIn, IsOptional } from 'class-validator';

/** Status filters for the incident queue: the four lifecycle states plus 'all'
 * (no filter). Single source of truth, reused by the validator below. */
export const INCIDENT_STATUS_FILTERS = ['open', 'in_progress', 'resolved', 'closed', 'all'] as const;

export type IncidentStatusFilter = (typeof INCIDENT_STATUS_FILTERS)[number];

/**
 * Query for GET /csat/incidents. Defaults to 'open' — this journey's ACs never
 * transition an incident out of 'open' (no resolve/close story exists for
 * BM-US-04, unlike BM-US-08's BM-041), so in practice every incident this API
 * creates stays 'open' unless a future slice adds that workflow; 'all' drops the
 * filter for a full audit view. Scope always stays the caller's own branch(es)
 * (AGENTS.md §5) — this value can only narrow, never widen it.
 */
export class ListIncidentsQuery {
  @IsOptional()
  @IsIn(INCIDENT_STATUS_FILTERS as unknown as string[])
  status?: IncidentStatusFilter;
}
