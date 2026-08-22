import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** How a customer profile came to exist. 'staff-created' is a Branch Manager
 * registering the customer during intake (story BM-031). 'self-registered' is
 * an authenticated mobile customer materialized into the branch-owned CIM
 * directory when they first place an order with that branch. */
export type RegistrationSource = 'staff-created' | 'self-registered';
export type CustomerAccountType = 'household' | 'commercial';

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

  /** Logical reference to auth.users.id for mobile self-registered customers.
   * It is null for staff-created profiles. A customer can order from more than
   * one branch, so each branch gets its own CIM profile for the same auth user. */
  @Column({ name: 'auth_user_id', type: 'uuid', nullable: true })
  authUserId!: string | null;

  @Column({ type: 'text' })
  name!: string;

  @Column({ name: 'contact_number', type: 'text' })
  contactNumber!: string;

  @Column({ name: 'delivery_address', type: 'text' })
  deliveryAddress!: string;

  /** 'staff-created' | 'self-registered' (see RegistrationSource). */
  @Column({ name: 'registration_source', type: 'text' })
  registrationSource!: RegistrationSource;

  /** Server-owned loyalty track selection copied from protected Auth claims for
   * mobile customers or explicitly captured by staff at registration. */
  @Column({ name: 'account_type', type: 'text', default: 'household' })
  accountType!: CustomerAccountType;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}
