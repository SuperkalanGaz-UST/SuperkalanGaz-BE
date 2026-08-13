import { IsNotEmpty, IsString, Matches } from 'class-validator';

/**
 * Canonical PH mobile in E.164: +63 then the 10-digit national number (always
 * starting 9). No spaces/dashes, no leading 0, no doubled +63 (AGENTS.md §16).
 * The web form masks input and submits this normalized form; the DTO is the
 * integrity boundary that enforces it.
 */
const PH_MOBILE_E164 = /^\+639\d{9}$/;

/**
 * Payload from the "Register new customer" inline intake form (stories
 * BM-029/BM-030). The ValidationPipe (whitelist: true) strips anything not
 * declared here, so the service only ever sees these three fields (AGENTS.md
 * §12). Note what is NOT here and is set by the server instead: branch_id (from
 * the verified principal) and registration_source ('staff-created', story
 * BM-031) — never trusted from the client (AGENTS.md §5). MVP fields only (§3.5):
 * loyalty / preferences / account-type from BM-030 are out of scope this slice.
 */
export class CreateCustomerDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  @IsNotEmpty()
  @Matches(PH_MOBILE_E164, { message: 'contactNumber must be a valid PH mobile in +639XXXXXXXXX form' })
  contactNumber!: string;

  @IsString()
  @IsNotEmpty()
  deliveryAddress!: string;
}
