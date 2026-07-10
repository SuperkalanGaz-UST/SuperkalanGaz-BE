import { IsNotEmpty, IsUUID } from 'class-validator';

/**
 * Payload for POST /service-requests/:id/dispatch — the Branch Manager assigning
 * a rider to a Pending request. Only the rider is chosen by the client;
 * everything else the dispatch sets (dispatched_at, status='Dispatched') is
 * server-owned (AGENTS.md §5, §8.2). The rider must belong to the request's own
 * branch and be Available — re-validated in the service, never trusted here.
 */
export class DispatchServiceRequestDto {
  @IsUUID()
  @IsNotEmpty()
  riderId!: string;
}
