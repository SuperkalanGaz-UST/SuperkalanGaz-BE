import { IsUUID } from 'class-validator';

/**
 * Payload for POST /loyalty/redemptions — a Branch Manager seeding a PENDING
 * household redemption into the approval queue (BM-US-03). The client supplies
 * only WHO and WHAT; the server owns everything else: branch_id (from the verified
 * principal), track ('household'), status ('pending'), and the points_spent /
 * reward_description snapshot taken from the catalog item (AGENTS.md §5). No
 * points are debited here — that happens on approval.
 *
 * The ValidationPipe (whitelist: true) strips anything not declared here.
 */
export class CreateRedemptionDto {
  /** The customer redeeming. The service validates it is a live cim.customers
   * profile in the caller's own branch before persisting (integrity check in the
   * service layer — the schema has no FK constraints, AGENTS.md §6). */
  @IsUUID()
  customerId!: string;

  /** The household catalog reward being redeemed. The service validates it is
   * active, in the same branch, and in stock. */
  @IsUUID()
  catalogItemId!: string;
}
