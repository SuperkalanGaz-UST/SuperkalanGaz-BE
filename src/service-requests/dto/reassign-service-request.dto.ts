import { IsNotEmpty, IsUUID } from 'class-validator';

/**
 * Payload for POST /service-requests/:id/reassign — the Branch Manager
 * replacing the assigned rider on a delayed, still-in-flight request (story
 * BM-010). Only the new rider is chosen by the client; the request must
 * already be Dispatched/En Route with a currently assigned rider (checked in
 * the service, never trusted here). The new rider must belong to the request's
 * own branch and be Available — re-validated server-side (AGENTS.md §5).
 */
export class ReassignServiceRequestDto {
  @IsUUID()
  @IsNotEmpty()
  riderId!: string;
}
