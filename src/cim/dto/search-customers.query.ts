import { Transform } from 'class-transformer';
import { IsOptional, IsString, MinLength } from 'class-validator';

/**
 * Query for GET /customers, serving two callers:
 *  - the intake autocomplete passes ?search=<term> to find customers to select
 *    (stories BM-024/BM-025) — when present, the term must be >= 2 chars (a
 *    too-short term is a 400) so we never run an unbounded '%%' name scan;
 *  - the CIM Customers directory (story BM-031) passes NO term to list the
 *    branch's customers — the service caps that listing, so it is still bounded.
 * The value is trimmed before length validation so "  a " (one real char) is
 * rejected. Scope (branch + soft-delete) is applied in the service from the
 * verified principal, never widened by this input (AGENTS.md §5).
 */
export class SearchCustomersQuery {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(2)
  search?: string;
}
