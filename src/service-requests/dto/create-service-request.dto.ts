import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Min,
} from 'class-validator';

/**
 * Canonical PH mobile in E.164: +63 then the 10-digit national number (always
 * starting 9). No spaces/dashes, no leading 0, no doubled +63 (AGENTS.md §16).
 * The web form masks input and submits this normalized form; the DTO enforces it.
 */
const PH_MOBILE_E164 = /^\+639\d{9}$/;

/**
 * Payload from the branch "New service request" (walk-in / phone) intake form.
 * The ValidationPipe (whitelist: true) strips anything not declared here, so the
 * service only ever sees these fields (AGENTS.md §12). Note what is NOT here and
 * is set by the server instead: branch_id (from the verified principal),
 * order_source ('Walk-in/Phone'), and status ('Pending') — never trusted from
 * the client (AGENTS.md §5, §8.2).
 */
export class CreateServiceRequestDto {
  /**
   * OPTIONAL link to an existing CIM customer profile selected at intake
   * (stories BM-029..BM-032). Walk-in intake without a linked customer must
   * still work exactly as before (story BM-005), so this is optional — when
   * present it must be a UUID, and the service validates it is a live customer in
   * the caller's own branch. The denormalized customer_* fields below stay
   * required regardless: they are the order's snapshot.
   */
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsString()
  @IsNotEmpty()
  customerName!: string;

  @IsString()
  @IsNotEmpty()
  @Matches(PH_MOBILE_E164, { message: 'customerContact must be a valid PH mobile in +639XXXXXXXXX form' })
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
