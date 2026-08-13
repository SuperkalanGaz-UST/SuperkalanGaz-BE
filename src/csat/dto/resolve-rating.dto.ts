import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString } from 'class-validator';

/**
 * Payload for POST /csat/ratings/:id/resolve — the Branch Manager closing the
 * loop on a low-CSAT delivery (stories BM-040 + BM-041). The note is REQUIRED
 * and non-empty: BM-041's AC is "mark as Addressed AFTER logging a resolution",
 * so the two are a single atomic action here rather than a status flip that can
 * leave an empty audit trail. Trimmed before the emptiness check so "   " is
 * rejected.
 *
 * Everything else is server-owned: resolution_status ('Resolved'), resolved_by
 * (the verified principal), and resolved_at — never trusted from the client
 * (AGENTS.md §5).
 */
export class ResolveRatingDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty({ message: 'A resolution note is required' })
  note!: string;
}
