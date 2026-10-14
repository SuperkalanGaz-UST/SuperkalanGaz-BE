import { IsOptional, IsUUID } from 'class-validator';

/**
 * A Branch Owner with multiple assigned branches must send the selected UUID.
 * The service still intersects it with the verified JWT-derived branch scope.
 */
export class DeliveryProofQuery {
  @IsOptional()
  @IsUUID()
  branchId?: string;
}
