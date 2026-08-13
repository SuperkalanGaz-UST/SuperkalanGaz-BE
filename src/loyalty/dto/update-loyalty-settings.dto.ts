import { IsBoolean } from 'class-validator';

/**
 * Payload for PATCH /loyalty/settings — toggles the caller's branch loyalty
 * Dual Authorization (story BM-013). true => redemption requests enter the
 * pending Rewards Claiming queue for manual approve/reject; false => requests are
 * auto-approved and coded on creation, bypassing the queue.
 */
export class UpdateLoyaltySettingsDto {
  @IsBoolean()
  dualAuth!: boolean;
}
