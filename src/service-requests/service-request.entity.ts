import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

const decimalTransformer = {
  to: (value: number | null) => value,
  from: (value: string | null) => (value === null ? null : Number(value)),
};

/** Channel an order came through — mandatory for channel-level SLA reporting
 * (AGENTS.md §8.2). Walk-in/phone intake is staff-initiated; the mobile app is
 * customer-initiated (later slice). */
export type OrderSource = 'Mobile App' | 'Walk-in/Phone';

export type PaymentMethod = 'Cash on Delivery' | 'PayMongo';
export type PaymentStatus = 'Unpaid' | 'Pending' | 'Paid';

/** Lifecycle state of a Service Request. Advances along the SLA chain: later
 * slices move a row Pending → Dispatched → En Route → Delivered. 'Under Review'
 * is a side-branch set when a Branch Manager logs a lost/undelivered cylinder
 * complaint against a Dispatched/En Route/Delivered order (story BM-021,
 * journey BM-US-04) — it does NOT erase or overwrite delivered_at or any of the
 * other SLA timestamps, which stay intact for reporting. There is no DB CHECK
 * constraint on this column (plain text), so this union is the only guard. */
export type ServiceRequestStatus =
  | 'Pending'
  | 'Dispatched'
  | 'En Route'
  | 'Delivered'
  | 'Cancelled'
  | 'Under Review';

/**
 * Maps srd.service_requests — one row per LPG delivery order (a "Service
 * Request" in ITIL 4 terms, AGENTS.md §9). Created by branch intake (walk-in /
 * phone) in this slice; rider assignment, dispatch and delivery come later and
 * populate the trailing SLA timestamps. Soft delete only (AGENTS.md §3.2):
 * deleted_at marks a row retired; this API never hard-deletes.
 */
@Entity({ schema: 'srd', name: 'service_requests' })
export class ServiceRequest {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Tenancy handle — server-derived from the verified principal, never the
   * client. No FK by design (AGENTS.md §6); integrity is checked in the service. */
  @Column({ name: 'branch_id', type: 'uuid' })
  branchId!: string;

  @Column({ name: 'order_source', type: 'text' })
  orderSource!: OrderSource;

  @Column({ type: 'text', default: 'Pending' })
  status!: ServiceRequestStatus;

  /** Optional link to the CIM customer profile this order was filed against
   * (stories BM-029..BM-032). Null for walk-in intake with no linked customer —
   * that path is unchanged (story BM-005). No FK by design (AGENTS.md §6); the
   * service validates the customer is live and in the SAME branch before
   * persisting. The denormalized customer_* fields below remain the order's
   * point-in-time snapshot even when this is set. */
  @Column({ name: 'customer_id', type: 'uuid', nullable: true })
  customerId!: string | null;

  // Customer details are denormalized onto the order as a point-in-time snapshot.
  // A CIM profile may now be linked via customer_id above, but these captured
  // values are kept as-is so the order reflects what was entered at intake.
  @Column({ name: 'customer_name', type: 'text' })
  customerName!: string;

  @Column({ name: 'customer_contact', type: 'text' })
  customerContact!: string;

  @Column({ name: 'delivery_address', type: 'text' })
  deliveryAddress!: string;

  /** Canonical product key; the amount fields below preserve the price used. */
  @Column({ name: 'cylinder_size', type: 'text' })
  cylinderSize!: string;

  @Column({ type: 'int' })
  quantity!: number;

  @Column({
    name: 'unit_price',
    type: 'numeric',
    precision: 10,
    scale: 2,
    nullable: true,
    transformer: decimalTransformer,
  })
  unitPrice!: number | null;

  @Column({
    name: 'total_amount',
    type: 'numeric',
    precision: 12,
    scale: 2,
    nullable: true,
    transformer: decimalTransformer,
  })
  totalAmount!: number | null;

  /** CU-017 payment state. Provider secrets never enter this entity; only the
   * identifiers needed to reconcile a signed PayMongo callback are retained. */
  @Column({ name: 'payment_method', type: 'text', default: 'Cash on Delivery' })
  paymentMethod!: PaymentMethod;

  @Column({ name: 'payment_status', type: 'text', default: 'Unpaid' })
  paymentStatus!: PaymentStatus;

  @Column({ name: 'paymongo_checkout_session_id', type: 'text', nullable: true })
  paymongoCheckoutSessionId!: string | null;

  @Column({ name: 'paymongo_checkout_url', type: 'text', nullable: true })
  paymongoCheckoutUrl!: string | null;

  @Column({ name: 'paymongo_reference', type: 'text', nullable: true })
  paymongoReference!: string | null;

  @Column({ name: 'paymongo_payment_id', type: 'text', nullable: true })
  paymongoPaymentId!: string | null;

  @Column({ name: 'paymongo_webhook_event_id', type: 'text', nullable: true })
  paymongoWebhookEventId!: string | null;

  @Column({ name: 'payment_paid_at', type: 'timestamptz', nullable: true })
  paymentPaidAt!: Date | null;

  @Column({ name: 'special_instructions', type: 'text', nullable: true })
  specialInstructions!: string | null;

  /** The rider assigned on dispatch (fleet.riders id). Null until dispatched;
   * set alongside dispatched_at + status='Dispatched'. No FK by design
   * (AGENTS.md §6) — the service validates the rider is live, Available, and in
   * the same branch before persisting. */
  @Column({ name: 'rider_id', type: 'uuid', nullable: true })
  riderId!: string | null;

  // Four-timestamp SLA chain (AGENTS.md §8.2). requested_at is set on create;
  // the rest stay null until the dispatch / in-transit / delivery slices land.
  @Column({ name: 'requested_at', type: 'timestamptz' })
  requestedAt!: Date;

  @Column({ name: 'dispatched_at', type: 'timestamptz', nullable: true })
  dispatchedAt!: Date | null;

  @Column({ name: 'in_transit_at', type: 'timestamptz', nullable: true })
  inTransitAt!: Date | null;

  @Column({ name: 'delivered_at', type: 'timestamptz', nullable: true })
  deliveredAt!: Date | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;

  /** The Branch Manager's logged delay reason (story BM-011), a combined
   * "category: note" display string. Null until a delay reason is logged. */
  @Column({ name: 'delay_reason', type: 'text', nullable: true })
  delayReason!: string | null;

  /**
   * PERSISTED SLA breach record (story BM-012). Computed once, at delivery,
   * from the four real SLA timestamps against core.sla_configurations — see
   * ServiceRequestsService.deliver(). Because reassignment never touches
   * dispatched_at/in_transit_at/delivered_at, this record survives any later
   * reassignment untouched ("the original SLA breach is not erased").
   * sla_breach_segment is the FIRST segment found in breach, chronologically:
   * 'request_to_dispatch' | 'dispatch_to_in_transit' | 'in_transit_to_delivery'.
   */
  @Column({ name: 'sla_breached', type: 'boolean', default: false })
  slaBreached!: boolean;

  @Column({ name: 'sla_breach_segment', type: 'text', nullable: true })
  slaBreachSegment!: string | null;

  @Column({ name: 'sla_breached_at', type: 'timestamptz', nullable: true })
  slaBreachedAt!: Date | null;
}
