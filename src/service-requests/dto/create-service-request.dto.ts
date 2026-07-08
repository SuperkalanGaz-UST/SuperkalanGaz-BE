import { IsInt, IsNotEmpty, IsOptional, IsString, Min } from 'class-validator';

/**
 * Payload from the branch "New service request" (walk-in / phone) intake form.
 * The ValidationPipe (whitelist: true) strips anything not declared here, so the
 * service only ever sees these fields (AGENTS.md §12). Note what is NOT here and
 * is set by the server instead: branch_id (from the verified principal),
 * order_source ('Walk-in/Phone'), and status ('Pending') — never trusted from
 * the client (AGENTS.md §5, §8.2).
 */
export class CreateServiceRequestDto {
  @IsString()
  @IsNotEmpty()
  customerName!: string;

  @IsString()
  @IsNotEmpty()
  customerContact!: string;

  @IsString()
  @IsNotEmpty()
  deliveryAddress!: string;

  // Plain string for MVP (e.g. "11kg"); a products/pricing catalog is deferred
  // (AGENTS.md §13), so this is free text rather than a catalog reference.
  @IsString()
  @IsNotEmpty()
  cylinderSize!: string;

  @IsInt()
  @Min(1)
  quantity!: number;

  @IsOptional()
  @IsString()
  specialInstructions?: string;
}
