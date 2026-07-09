import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { Principal } from '../auth/principal';
import { CimService } from '../cim/cim.service';
import { FleetService } from '../fleet/fleet.service';
import { DispatchServiceRequestDto } from './dto/dispatch-service-request.dto';
import { CreateServiceRequestDto } from './dto/create-service-request.dto';
import { ServiceRequest } from './service-request.entity';

/**
 * Service Request intake & queue (SRD module). This slice covers create
 * (walk-in / phone intake), the branch queue list, and detail lookup. Rider
 * assignment, dispatch, in-transit and delivery are later slices — they will
 * populate the trailing SLA timestamps left null here.
 *
 * All scoping derives from the verified Principal, never from request
 * params/body (AGENTS.md §5). Isolation is enforced here in the application
 * layer, not by the DB — a missing branch filter is a cross-tenant leak.
 */
@Injectable()
export class ServiceRequestsService {
  constructor(
    @InjectRepository(ServiceRequest)
    private readonly serviceRequests: Repository<ServiceRequest>,
    // Reused to validate a rider at dispatch time and flip them to 'On Delivery'
    // — mirrors how BranchesService reuses GoTrueAdminService across modules.
    private readonly fleet: FleetService,
    // Reused to validate an optionally-linked customer at create time (same
    // cross-module reuse pattern as fleet above).
    private readonly cim: CimService,
  ) {}

  /**
   * Walk-in / phone intake. The server owns branch_id (the caller's own
   * branch), order_source ('Walk-in/Phone', story BM-027) and status
   * ('Pending') — the client only supplies the customer/order details.
   *
   * An optional customerId links the order to a CIM profile (stories
   * BM-029..BM-032). When supplied it must resolve to a live customer in the
   * SAME branch as the request (integrity check in the service layer, AGENTS.md
   * §6) — else 400. When omitted the order is filed with customer_id NULL, so
   * walk-in intake without a profile is unchanged (story BM-005). The
   * denormalized customer_* fields are always captured as the order's snapshot.
   */
  async create(
    principal: Principal,
    dto: CreateServiceRequestDto,
  ): Promise<ServiceRequest> {
    const branchId = this.requireBranch(principal);

    // Validate the optional customer link before persisting. A customer from
    // another branch (or unknown / soft-deleted) is rejected — mirrors the rider
    // check in dispatch. Only the id is stored; the customer_* snapshot fields
    // still come from the intake form.
    let customerId: string | null = null;
    if (dto.customerId) {
      const customer = await this.cim.findInBranch(dto.customerId, branchId);
      if (!customer) {
        throw new BadRequestException('Customer not found in this branch');
      }
      customerId = customer.id;
    }

    const now = new Date();
    const serviceRequest = this.serviceRequests.create({
      branchId,
      orderSource: 'Walk-in/Phone',
      status: 'Pending',
      customerId,
      customerName: dto.customerName.trim(),
      customerContact: dto.customerContact.trim(),
      deliveryAddress: dto.deliveryAddress.trim(),
      cylinderSize: dto.cylinderSize.trim(),
      quantity: dto.quantity,
      specialInstructions: dto.specialInstructions?.trim() || null,
      // requested_at opens the SLA chain now; the rest fill in on later slices.
      requestedAt: now,
      dispatchedAt: null,
      inTransitAt: null,
      deliveredAt: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });

    return this.serviceRequests.save(serviceRequest);
  }

  /**
   * The caller's branch queue: live requests for their own branch(es) only,
   * newest first. Branch scope comes from the principal — request input can
   * never widen it (AGENTS.md §5).
   */
  async list(principal: Principal): Promise<ServiceRequest[]> {
    const branchIds = this.requireBranches(principal);

    return this.serviceRequests.find({
      where: { branchId: In(branchIds), deletedAt: IsNull() },
      order: { requestedAt: 'DESC' },
    });
  }

  /**
   * A single request, scoped to the caller's branch(es). Out-of-scope,
   * soft-deleted, or unknown ids all return 404 — never leak whether a row
   * exists in another branch (AGENTS.md §5).
   */
  async findById(principal: Principal, id: string): Promise<ServiceRequest> {
    const branchIds = this.requireBranches(principal);

    const serviceRequest = await this.serviceRequests.findOne({
      where: { id, branchId: In(branchIds), deletedAt: IsNull() },
    });
    if (!serviceRequest) throw new NotFoundException('Service request not found');
    return serviceRequest;
  }

  /**
   * Manual dispatch (story BM-004): assign an Available rider to a Pending
   * request, opening the request→dispatch leg of the SLA chain (AGENTS.md §8.2).
   * This is MANUAL dispatch only — no in_transit_at / "En Route" transition here;
   * that leg is GPS/hardware-dependent and deferred (AGENTS.md §8).
   *
   * Order of checks (all in the service layer, AGENTS.md §5/§6):
   *  1. Load the SR scoped to the caller's branches — 404 if missing,
   *     soft-deleted, or out of scope (never leak another branch's rows).
   *  2. Race guard: reject if already dispatched. Re-checked below with a
   *     conditional UPDATE, not just here, so two concurrent dispatches can't
   *     both win (AGENTS.md §8.2 double-dispatch defense).
   *  3. Validate the rider via the Fleet service: live, Available, and in the
   *     SAME branch as the request — else 400.
   *  4. Commit with a conditional UPDATE (WHERE dispatched_at IS NULL): 0 rows
   *     means another request won the race → 409. On success, flip the rider to
   *     'On Delivery' so they drop out of the Available list (prevents
   *     double-assignment).
   *
   * The assignment is then locked — there is no re-dispatch (the race guard
   * enforces this). The rider returns to 'Available' and delivered_at is stamped
   * in the later "mark delivered" slice (Slice 3) — NOT here.
   */
  async dispatch(
    principal: Principal,
    id: string,
    dto: DispatchServiceRequestDto,
  ): Promise<ServiceRequest> {
    const branchIds = this.requireBranches(principal);

    // 1. Load, scoped to the caller's branch(es). Out-of-scope / soft-deleted /
    //    unknown ids all 404 — same as findById (AGENTS.md §5).
    const serviceRequest = await this.serviceRequests.findOne({
      where: { id, branchId: In(branchIds), deletedAt: IsNull() },
    });
    if (!serviceRequest) throw new NotFoundException('Service request not found');

    // 2. Fast conflict feedback before we touch the fleet. The authoritative
    //    guard is the conditional UPDATE in step 4.
    if (serviceRequest.dispatchedAt !== null || serviceRequest.status !== 'Pending') {
      throw new ConflictException('Service request already dispatched');
    }

    // 3. Rider must be live, Available, and in the SAME branch as the request.
    const rider = await this.fleet.findAssignableRider(
      dto.riderId,
      serviceRequest.branchId,
    );
    if (!rider) throw new BadRequestException('Rider is not assignable');

    // 4. Commit atomically: only the request still Pending / not-yet-dispatched
    //    is updated. 0 rows affected means a concurrent dispatch already won —
    //    treat that as the conflict so both callers can't dispatch the same
    //    request (AGENTS.md §8.2).
    const now = new Date();
    const result = await this.serviceRequests
      .createQueryBuilder()
      .update(ServiceRequest)
      .set({
        riderId: rider.id,
        dispatchedAt: now,
        status: 'Dispatched',
        updatedAt: now,
      })
      .where('id = :id AND dispatched_at IS NULL AND status = :status', {
        id,
        status: 'Pending',
      })
      .execute();
    if (!result.affected) {
      throw new ConflictException('Service request already dispatched');
    }

    // Rider drops out of the Available list so no other request picks them.
    await this.fleet.markOnDelivery(rider.id);

    // Reflect the committed state back to the caller without a re-read.
    serviceRequest.riderId = rider.id;
    serviceRequest.dispatchedAt = now;
    serviceRequest.status = 'Dispatched';
    serviceRequest.updatedAt = now;
    return serviceRequest;
  }

  /**
   * Mark delivered (story BM-007): close the SLA chain on an out-for-delivery
   * request and return its rider to the roster. This is the inverse of dispatch.
   *
   * Order of checks (all in the service layer, AGENTS.md §5/§6):
   *  1. Load the SR scoped to the caller's branches — 404 if missing,
   *     soft-deleted, or out of scope (never leak another branch's rows).
   *  2. Race guard (mirrors dispatch): the request must currently be out for
   *     delivery — dispatched_at IS NOT NULL AND delivered_at IS NULL (status
   *     'Dispatched' or 'En Route'). Enforced authoritatively by the conditional
   *     UPDATE below, so a still-Pending / already-Delivered / Cancelled request
   *     (0 rows affected) is a 409 and two concurrent deliveries can't both win.
   *  3. Commit: stamp delivered_at + status='Delivered', bump updated_at.
   *  4. Return the rider to 'Available' so the branch can dispatch them again.
   *
   * En Route / in_transit_at is GPS/hardware-dependent and deferred (AGENTS.md
   * §8) — a request may be delivered with in_transit_at still NULL; that is
   * expected and NOT backfilled here.
   *
   * PANEL-CHECK: BM-007's CSAT rating prompt to the customer is a customer MOBILE
   * concern (customers are mobile-only, AGENTS.md §7) — it is deliberately NOT
   * triggered from this backend endpoint. Out of scope for this slice.
   */
  async deliver(principal: Principal, id: string): Promise<ServiceRequest> {
    const branchIds = this.requireBranches(principal);

    // 1. Load, scoped to the caller's branch(es). Out-of-scope / soft-deleted /
    //    unknown ids all 404 — same as findById (AGENTS.md §5).
    const serviceRequest = await this.serviceRequests.findOne({
      where: { id, branchId: In(branchIds), deletedAt: IsNull() },
    });
    if (!serviceRequest) throw new NotFoundException('Service request not found');

    // 2 + 3. Commit atomically: only a request that is out for delivery
    //    (dispatched, not yet delivered) is updated. 0 rows affected means the
    //    request is not out for delivery (still Pending, already Delivered, or
    //    Cancelled) — or a concurrent deliver already won — so treat it as the
    //    conflict, mirroring the dispatch race guard (AGENTS.md §8.2).
    const now = new Date();
    const result = await this.serviceRequests
      .createQueryBuilder()
      .update(ServiceRequest)
      .set({
        deliveredAt: now,
        status: 'Delivered',
        updatedAt: now,
      })
      .where(
        'id = :id AND dispatched_at IS NOT NULL AND delivered_at IS NULL',
        { id },
      )
      .execute();
    if (!result.affected) {
      throw new ConflictException('Service request is not out for delivery');
    }

    // 4. Return the assigned rider to the Available roster (inverse of dispatch's
    //    markOnDelivery). rider_id is always set on an out-for-delivery request,
    //    but guard defensively in case of legacy data.
    if (serviceRequest.riderId) {
      await this.fleet.markAvailable(serviceRequest.riderId);
    }

    // Reflect the committed state back to the caller without a re-read.
    serviceRequest.deliveredAt = now;
    serviceRequest.status = 'Delivered';
    serviceRequest.updatedAt = now;
    return serviceRequest;
  }

  /** The caller's active branch UUIDs; fails closed if they have none. */
  private requireBranches(principal: Principal): string[] {
    if (principal.branchIds.length === 0) {
      throw new ForbiddenException('Caller has no active branch');
    }
    return principal.branchIds;
  }

  /** The single branch a new request is filed under — the caller's own branch. */
  private requireBranch(principal: Principal): string {
    return this.requireBranches(principal)[0];
  }
}
