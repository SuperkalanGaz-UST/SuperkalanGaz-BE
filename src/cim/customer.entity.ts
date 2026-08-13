import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** How a customer profile came to exist. 'staff-created' is a Branch Manager
 * registering the customer during intake (story BM-031). 'self-registered' is
 * customer mobile self-registration — a valid value, but no code path writes it
 * yet (the customer mobile client is not built). Only 'staff-created' is emitted
 * by this API today. */
export type RegistrationSource = 'staff-created' | 'self-registered';

/**
 * Maps cim.customers — one row per customer profile a branch has registered
 * (Customer Information Management module, AGENTS.md §8.1 / ITIL 4 Relationship
 * Management §9). Used to search existing customers and autopopulate an order at
 * intake, and to register new customers inline. MVP fields only (§3.5): the
 * loyalty track / preferences / account-type fields hinted at in BM-030 are
 * deliberately absent — they are not modelled in this slice. Soft delete only
 * (AGENTS.md §3.2): deleted_at marks a profile retired; this API never
 * hard-deletes.
 */
@Entity({ schema: 'cim', name: 'customers' })
export class Customer {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Tenancy handle — the branch that registered this customer. Server-derived
   * from the verified principal, never the client. No FK by design (AGENTS.md
   * §6); integrity is checked in the service. */
  @Column({ name: 'branch_id', type: 'uuid' })
  branchId!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ name: 'contact_number', type: 'text' })
  contactNumber!: string;

  @Column({ name: 'delivery_address', type: 'text' })
  deliveryAddress!: string;

  /** 'staff-created' | 'self-registered'. Only 'staff-created' is written here
   * (see RegistrationSource). */
  @Column({ name: 'registration_source', type: 'text' })
  registrationSource!: RegistrationSource;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}
