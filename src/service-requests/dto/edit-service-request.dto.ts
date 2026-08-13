import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
  registerDecorator,
  ValidationArguments,
} from 'class-validator';

/**
 * Class-level guard: a PATCH must change SOMETHING. Every field below is
 * optional, so an empty body would otherwise validate; this rejects `{}` (and a
 * body of only unknown, whitelist-stripped keys) with 400. It reads the whole
 * object via args.object, so it runs regardless of which fields are present —
 * unlike a per-property check, which @IsOptional would skip when the field is
 * absent. Attached to a synthetic '' property so no real field's @IsOptional
 * short-circuits it.
 */
function AtLeastOneField(keys: string[]): ClassDecorator {
  return (target) => {
    registerDecorator({
      name: 'atLeastOneField',
      target: target,
      propertyName: '',
      validator: {
        validate(_value: unknown, args: ValidationArguments): boolean {
          const obj = args.object as Record<string, unknown>;
          return keys.some((k) => obj[k] !== undefined);
        },
        defaultMessage(): string {
          return 'At least one field must be provided to edit';
        },
      },
    });
  };
}

/**
 * Payload for PATCH /service-requests/:id — a Branch Manager editing a
 * pre-dispatch request (stories BM-034/035/037). All fields are OPTIONAL but at
 * least one must be present (empty body → 400). Only these mutable order details
 * may be edited; server-owned fields (branch_id, order_source, status, the SLA
 * timestamps) are never accepted from the client (AGENTS.md §5). The pre-dispatch
 * guard itself is enforced in the service via a race-safe conditional UPDATE.
 */
@AtLeastOneField([
  'deliveryAddress',
  'cylinderSize',
  'quantity',
  'specialInstructions',
])
export class EditServiceRequestDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  deliveryAddress?: string;

  // Plain string for MVP (e.g. "11kg"); a products/pricing catalog is deferred
  // (AGENTS.md §13), so this stays free text — mirrors create.
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  cylinderSize?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  quantity?: number;

  // May be an empty string: passing "" intentionally clears the instructions.
  // Hence @IsString() without @IsNotEmpty(), unlike the fields above.
  @IsOptional()
  @IsString()
  specialInstructions?: string;
}
