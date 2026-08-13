import { IsNotEmpty, IsString } from 'class-validator';

/**
 * Payload for POST /service-requests/:id/cancel — a Branch Manager cancelling a
 * pre-dispatch request (story BM-036). A non-empty reason is REQUIRED (empty /
 * missing → 400): it is written verbatim to the status-history audit trail so
 * every cancellation is accountable. The pre-dispatch guard and the status flip
 * to 'Cancelled' are enforced in the service via a race-safe conditional UPDATE.
 */
export class CancelServiceRequestDto {
  @IsString()
  @IsNotEmpty()
  reason!: string;
}
