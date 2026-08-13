import { IsUUID } from 'class-validator';

/**
 * Payload for POST /loyalty/commercial/redemptions — a Branch Manager filing a
 * PENDING commercial "30+1" free-cylinder redemption into the approval queue. The
 * client supplies only WHO; the server owns everything else: branch_id (from the
 * verified principal), track ('commercial_30plus1'), status ('pending'), and the
 * reward_description snapshot. There is no reward catalog and no points on this
 * track — the reward is a free cylinder, so no catalogItemId is accepted.
 *
 * Eligibility (an account with completed_cycles >= 1) is validated in the service.
 */
export class CreateCommercialRedemptionDto {
  /** The commercial customer redeeming an earned free cylinder. The service
   * validates it is a live cim.customers profile in the caller's own branch AND
   * that its commercial account has at least one completed cycle. */
  @IsUUID()
  customerId!: string;
}
