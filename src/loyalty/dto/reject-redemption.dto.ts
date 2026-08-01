import { IsNotEmpty, IsString } from 'class-validator';

/**
 * Payload for POST /loyalty/redemptions/:id/reject — a Branch Manager declining a
 * pending household redemption (BM-US-03). A non-empty reason is REQUIRED (empty /
 * missing → 400): it is recorded verbatim on the redemption (rejected_reason) so
 * every rejection is accountable — mirrors CancelServiceRequestDto. The
 * pending→rejected transition is enforced in the service via a race-safe
 * conditional UPDATE.
 */
export class RejectRedemptionDto {
  @IsString()
  @IsNotEmpty()
  reason!: string;
}
