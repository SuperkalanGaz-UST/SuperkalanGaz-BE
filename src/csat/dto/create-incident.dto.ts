import { Transform } from 'class-transformer';
import { IsIn, IsNotEmpty, IsString, IsUUID } from 'class-validator';
import { IncidentCategory } from '../incident.entity';

/** Issue types offered on the "Log Complaint" form (BM-US-04 AC2: "issue type").
 * Single source of truth, reused by the validator below. Must stay in sync with
 * the DB CHECK (incidents_category_check). */
export const INCIDENT_CATEGORIES: readonly IncidentCategory[] = [
  'lost_cylinder',
  'late_delivery',
  'wrong_item',
  'safety',
  'billing',
  'other',
];

/**
 * Payload for POST /csat/incidents — the Branch Manager logging a complaint
 * against a Service Request (stories BM-019/020/021 combined into one atomic
 * action; see the service for why). The server owns branch_id, customer_id
 * (copied from the SR), status ('open'), priority ('medium'), and the SR status
 * transition to 'Under Review' — never trusted from the client (AGENTS.md §5).
 */
export class CreateIncidentDto {
  /** The Service Request this complaint is about — the outcome of BM-019
   * "locate the associated service request" (done via the existing Orders
   * queue, not a new search flow here). */
  @IsUUID()
  serviceRequestId!: string;

  @IsIn(INCIDENT_CATEGORIES as unknown as string[])
  category!: IncidentCategory;

  /** The free-text account of the incident (consolidated AC2 "free-text
   * description"; the same text also satisfies BM-020's "resolution note"). */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty({ message: 'A description is required' })
  description!: string;
}
