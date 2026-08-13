import { Transform } from 'class-transformer';
import { IsString, MinLength } from 'class-validator';

/**
 * Query for GET /customers. The intake autocomplete calls this with
 * ?search=<term> to find existing customers to select (stories BM-024/BM-025).
 * The term is REQUIRED and must be at least 2 characters — a missing or too-short
 * term is a 400, so we never run an unbounded '%%' scan across the branch. The
 * value is trimmed before length validation so "  a " (one real char) is
 * rejected. Scope (branch + soft-delete) is applied in the service from the
 * verified principal, never widened by this input (AGENTS.md §5).
 */
export class SearchCustomersQuery {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(2)
  search!: string;
}
