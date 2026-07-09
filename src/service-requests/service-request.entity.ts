import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** Channel an order came through — mandatory for channel-level SLA reporting
 * (AGENTS.md §8.2). Walk-in/phone intake is staff-initiated; the mobile app is
 * customer-initiated (later slice). */
export type OrderSource = 'Mobile App' | 'Walk-in/Phone';

/** Lifecycle state of a Service Request. Advances along the SLA chain: later
 * slices move a row Pending → Dispatched → En Route → Delivered. */
export type ServiceRequestStatus =
  | 'Pending'
  | 'Dispatched'
  | 'En Route'
  | 'Delivered'
  | 'Cancelled';

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

  // Customer details are denormalized onto the order for now — the CIM module
  // (customer profiles) is not built yet, so intake captures them inline.
  @Column({ name: 'customer_name', type: 'text' })
  customerName!: string;

  @Column({ name: 'customer_contact', type: 'text' })
  customerContact!: string;

  @Column({ name: 'delivery_address', type: 'text' })
  deliveryAddress!: string;

  /** Plain string for MVP (e.g. "11kg"); a products/pricing catalog is deferred
   * (AGENTS.md §13). */
  @Column({ name: 'cylinder_size', type: 'text' })
  cylinderSize!: string;

  @Column({ type: 'int' })
  quantity!: number;

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
}
