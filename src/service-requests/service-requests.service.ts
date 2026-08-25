import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  And,
  In,
  IsNull,
  LessThan,
  MoreThanOrEqual,
  Repository,
} from 'typeorm';
import { Principal } from '../auth/principal';
import { Branch } from '../branches/branch.entity';
import { BranchReportQuery } from '../common/dto/branch-report.query';
import { reportRangeFrom } from '../common/report-range';
import { CimService } from '../cim/cim.service';
import { FleetService } from '../fleet/fleet.service';
import { LoyaltyService } from '../loyalty/loyalty.service';
import { PricesService } from '../prices/prices.service';
import { CreateCustomerServiceRequestDto } from './dto/create-customer-service-request.dto';
import { DispatchServiceRequestDto } from './dto/dispatch-service-request.dto';
import { CreateServiceRequestDto } from './dto/create-service-request.dto';
import { EditServiceRequestDto } from './dto/edit-service-request.dto';
import { CancelServiceRequestDto } from './dto/cancel-service-request.dto';
import { ReassignServiceRequestDto } from './dto/reassign-service-request.dto';
import { LogDelayReasonDto } from './dto/log-delay-reason.dto';
import { OrderSource, ServiceRequest } from './service-request.entity';
import { ServiceRequestStatusHistory } from './service-request-status-history.entity';
import { SlaConfiguration, SlaSegment } from './sla-configuration.entity';
import { PayMongoService } from './paymongo.service';

/** Human labels for the delay-reason dropdown categories, used to build the
 * single combined `delay_reason` display string (story BM-011). */
const DELAY_REASON_LABELS: Record<string, string> = {
  traffic: 'Traffic',
  weather: 'Weather',
  customer_unavailable: 'Customer unavailable',
  vehicle_issue: 'Vehicle issue',
  address_issue: 'Address issue',
  other: 'Other',
};

/** Resolved SLA thresholds for one branch, keyed by segment. A missing key
 * means no active 'all'-channel threshold is configured (branch-specific or
 * global) for that segment — treated as "cannot breach" (fails quiet, never
 * flags a false breach from missing configuration). */
type ThresholdMap = Partial<Record<SlaSegment, number>>;

export type ReportSlaSegment =
  | 'request_to_dispatch'
  | 'dispatch_to_in_transit'
  | 'in_transit_to_delivery';

export interface SlaReportMetric {
  evaluated: number;
  compliant: number;
  breached: number;
  complianceRate: number | null;
}

export interface SlaOrderSourceMetric extends SlaReportMetric {
  total: number;
  notEvaluated: number;
}

export interface SlaBranchReport {
  totalServiceRequests: number;
  evaluatedRequests: number;
  withinSla: number;
  breaches: number;
  notEvaluated: number;
  overallComplianceRate: number | null;
  segments: Record<ReportSlaSegment, SlaReportMetric>;
  orderSources: Record<OrderSource, SlaOrderSourceMetric>;
}

/**
 * Service Request intake & queue (SRD module). Covers create (walk-in / phone
 * intake), the branch queue, detail lookup, dispatch/deliver, pre-dispatch
 * edit/cancel (BM-US-07), and the delayed-delivery journey (BM-US-02):
 * live SLA-at-risk flagging on the queue (BM-008), rider reassignment
 * (BM-010), delay-reason logging (BM-011), and the persisted SLA breach
 * record (BM-012), plus read-only Branch Owner SLA reporting.
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
    @InjectRepository(Branch)
    private readonly branches: Repository<Branch>,
    // Append-only audit trail for guarded lifecycle actions (edit / cancel,
    // BM-US-07; reassign / delay-reason, BM-US-02). Maps the existing
    // srd.service_request_status_history table.
    @InjectRepository(ServiceRequestStatusHistory)
    private readonly statusHistory: Repository<ServiceRequestStatusHistory>,
    // READ-ONLY: the Franchise Administrator's configured SLA breach
    // thresholds (BM-008's "configured breach threshold" — explicitly
    // FA-owned per the story). This module never writes to this table.
    @InjectRepository(SlaConfiguration)
    private readonly slaConfigurations: Repository<SlaConfiguration>,
    // Reused to validate a rider at dispatch time and flip them to 'On Delivery'
    // — mirrors how BranchesService reuses GoTrueAdminService across modules.
    private readonly fleet: FleetService,
    // Reused to validate an optionally-linked customer at create time (same
    // cross-module reuse pattern as fleet above).
    private readonly cim: CimService,
    // Shared catalog lookup. Money is resolved server-side and snapshotted so
    // staff clients cannot submit a forged price.
    private readonly prices: PricesService,
    private readonly payMongo: PayMongoService,
    private readonly loyalty: LoyaltyService,
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

    const product = await this.prices.findByCylinderSize(dto.cylinderSize);

    const now = new Date();
    const serviceRequest = this.serviceRequests.create({
      branchId,
      orderSource: 'Walk-in/Phone',
      status: 'Pending',
      customerId,
      customerName: dto.customerName.trim(),
      customerContact: dto.customerContact.trim(),
      deliveryAddress: dto.deliveryAddress.trim(),
      cylinderSize: product.cylinderSize,
      quantity: dto.quantity,
      unitPrice: product.unitPrice,
      totalAmount: Number((product.unitPrice * dto.quantity).toFixed(2)),
      paymentMethod: 'Cash on Delivery',
      paymentStatus: 'Unpaid',
      paymongoCheckoutSessionId: null,
      paymongoCheckoutUrl: null,
      paymongoReference: null,
      paymongoPaymentId: null,
      paymongoWebhookEventId: null,
      paymentPaidAt: null,
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
   * Customer-app order placement. The customer chooses the branch and the API
   * materializes their authenticated identity into that branch's CIM directory.
   * The order links to the resulting CIM profile; the profile retains the
   * auth.users reference needed to read the customer's own history.
   */
  async createForCustomer(
    principal: Principal,
    dto: CreateCustomerServiceRequestDto,
  ): Promise<ServiceRequest> {
    if (!principal.accountType) {
      throw new ForbiddenException('Customer account type is missing');
    }
    console.log('[service-requests-service] createForCustomer input', {
      userId: principal.userId,
      role: principal.role,
      branchId: dto.branchId,
      customerName: dto.customerName,
      quantity: dto.quantity,
      cylinderSize: dto.cylinderSize,
    });
    const branch = await this.branches.findOne({
      where: { id: dto.branchId, status: 'active' },
    });
    if (!branch) {
      throw new BadRequestException('Branch not found');
    }

    const customer = await this.cim.upsertSelfRegisteredInBranch({
      authUserId: principal.userId,
      branchId: branch.id,
      name: dto.customerName,
      contactNumber: dto.customerContact,
      deliveryAddress: dto.deliveryAddress,
      accountType: principal.accountType,
    });

    const product = await this.prices.findByCylinderSize(dto.cylinderSize);
    const now = new Date();
    const serviceRequest = this.serviceRequests.create({
      branchId: branch.id,
      orderSource: 'Mobile App',
      status: 'Pending',
      customerId: customer.id,
      customerName: dto.customerName.trim(),
      customerContact: dto.customerContact.trim(),
      deliveryAddress: dto.deliveryAddress.trim(),
      cylinderSize: product.cylinderSize,
      quantity: dto.quantity,
      unitPrice: product.unitPrice,
      totalAmount: Number((product.unitPrice * dto.quantity).toFixed(2)),
      paymentMethod: dto.paymentMethod,
      paymentStatus: 'Unpaid',
      paymongoCheckoutSessionId: null,
      paymongoCheckoutUrl: null,
      paymongoReference: null,
      paymongoPaymentId: null,
      paymongoWebhookEventId: null,
      paymentPaidAt: null,
      specialInstructions: dto.specialInstructions?.trim() || null,
      requestedAt: now,
      dispatchedAt: null,
      inTransitAt: null,
      deliveredAt: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });

    const saved = await this.serviceRequests.save(serviceRequest);
    console.log('[service-requests-service] createForCustomer saved', {
      id: saved.id,
      branchId: saved.branchId,
      status: saved.status,
      customerId: saved.customerId,
      orderSource: saved.orderSource,
    });
    return saved;
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

  /** Customer order history, newest first. */
  async listForCustomer(principal: Principal): Promise<ServiceRequest[]> {
    const profileIds = await this.cim.profileIdsForAuthUser(principal.userId);
    // Include the auth subject for legacy mobile orders written before mobile
    // customers were materialized into CIM. Migration 0025 rewrites those rows,
    // but this fallback keeps history readable during a rolling deployment.
    const ownedCustomerIds = [...new Set([principal.userId, ...profileIds])];
    return this.serviceRequests.find({
      where: { customerId: In(ownedCustomerIds), deletedAt: IsNull() },
      order: { requestedAt: 'DESC' },
    });
  }

  /**
   * The queue, enriched with a LIVE (non-persisted) "at risk" flag for
   * still-in-flight requests (story BM-008: "has been Pending or En Route
   * longer than the configured SLA threshold"). Dispatched is treated the same
   * as En Route — the GPS/Traccar pipeline that would transition a request to
   * 'En Route' is hardware-deferred (AGENTS.md §8), so in practice a request
   * never leaves 'Dispatched' before delivery; excluding it would make this
   * flag never fire (interpretation call, stated in the PR).
   *
   * This flag is computed fresh on every call — it is NOT the persisted
   * sla_breached column (that is written once, at delivery, by deliver()
   * below; see BM-012). Delivered/Cancelled/Under Review rows always read
   * slaAtRisk=false here; their permanent record is on the row itself.
   */
  async listWithSlaRisk(
    principal: Principal,
  ): Promise<{ serviceRequest: ServiceRequest; slaAtRisk: boolean; slaAtRiskSegment: SlaSegment | null }[]> {
    const branchIds = this.requireBranches(principal);
    const requests = await this.list(principal);
    if (requests.length === 0) return [];

    const thresholdsByBranch = await this.resolveThresholdsForBranches(branchIds);
    const now = new Date();

    return requests.map((sr) => {
      const { atRisk, segment } = this.computeAtRisk(
        sr,
        thresholdsByBranch.get(sr.branchId) ?? {},
        now,
      );
      return { serviceRequest: sr, slaAtRisk: atRisk, slaAtRiskSegment: segment };
    });
  }

  /**
   * Read-only SLA analytics for a Branch Owner. Each real timestamp segment is
   * evaluated independently. GPS-dependent legs remain explicitly unevaluated
   * when `in_transit_at` or a configured threshold is absent; the overall result
   * may still use the existing end-to-end fallback, but never invents segment
   * attribution.
   */
  async getSlaReport(
    principal: Principal,
    query: BranchReportQuery,
  ): Promise<SlaBranchReport> {
    const branchIds = this.reportBranchIds(principal, query.branchId);
    const { start, endExclusive } = reportRangeFrom(query);
    const requests = await this.serviceRequests.find({
      where: {
        branchId: In(branchIds),
        deliveredAt: And(MoreThanOrEqual(start), LessThan(endExclusive)),
        deletedAt: IsNull(),
      },
      order: { deliveredAt: 'DESC' },
    });
    const thresholdsByBranch = await this.resolveThresholdsForBranches(branchIds);

    const segments: SlaBranchReport['segments'] = {
      request_to_dispatch: this.emptySlaMetric(),
      dispatch_to_in_transit: this.emptySlaMetric(),
      in_transit_to_delivery: this.emptySlaMetric(),
    };
    const orderSources: SlaBranchReport['orderSources'] = {
      'Mobile App': { ...this.emptySlaMetric(), total: 0, notEvaluated: 0 },
      'Walk-in/Phone': { ...this.emptySlaMetric(), total: 0, notEvaluated: 0 },
    };

    let evaluatedRequests = 0;
    let withinSla = 0;
    let breaches = 0;

    for (const request of requests) {
      const thresholds = thresholdsByBranch.get(request.branchId) ?? {};
      const overallResults: boolean[] = [];
      const segmentInputs: Array<{
        key: ReportSlaSegment;
        from: Date | null;
        to: Date | null;
      }> = [
        {
          key: 'request_to_dispatch',
          from: request.requestedAt,
          to: request.dispatchedAt,
        },
        {
          key: 'dispatch_to_in_transit',
          from: request.dispatchedAt,
          to: request.inTransitAt,
        },
        {
          key: 'in_transit_to_delivery',
          from: request.inTransitAt,
          to: request.deliveredAt,
        },
      ];

      for (const input of segmentInputs) {
        const threshold = thresholds[input.key];
        if (threshold == null || !input.from || !input.to) continue;
        const compliant = this.minutesBetween(input.from, input.to) <= threshold;
        this.recordSlaOutcome(segments[input.key], compliant);
        overallResults.push(compliant);
      }

      // Without the GPS-dependent timestamp, use the same honest end-to-end
      // fallback as delivery-time breach persistence. It contributes only to
      // the overall/source result, never to either missing fine-grained segment.
      if (!request.inTransitAt && request.dispatchedAt && request.deliveredAt) {
        const endToEnd = thresholds.end_to_end;
        if (endToEnd != null) {
          overallResults.push(
            this.minutesBetween(request.dispatchedAt, request.deliveredAt) <= endToEnd,
          );
        }
      }

      const sourceMetric = orderSources[request.orderSource];
      sourceMetric.total += 1;
      if (overallResults.length === 0) {
        sourceMetric.notEvaluated += 1;
        continue;
      }

      const compliant = overallResults.every(Boolean);
      evaluatedRequests += 1;
      this.recordSlaOutcome(sourceMetric, compliant);
      if (compliant) withinSla += 1;
      else breaches += 1;
    }

    for (const metric of Object.values(segments)) this.finishSlaMetric(metric);
    for (const metric of Object.values(orderSources)) this.finishSlaMetric(metric);

    return {
      totalServiceRequests: requests.length,
      evaluatedRequests,
      withinSla,
      breaches,
      notEvaluated: requests.length - evaluatedRequests,
      overallComplianceRate: this.complianceRate(withinSla, evaluatedRequests),
      segments,
      orderSources,
    };
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
    if (
      serviceRequest.paymentMethod === 'PayMongo' &&
      serviceRequest.paymentStatus !== 'Paid'
    ) {
      throw new ConflictException('PayMongo payment is required before dispatch');
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
      .where(
        `id = :id
          AND branch_id = :branchId
          AND dispatched_at IS NULL
          AND status = :status
          AND (payment_method <> :paymongo OR payment_status = :paid)`,
        {
          id,
          branchId: serviceRequest.branchId,
          status: 'Pending',
          paymongo: 'PayMongo',
          paid: 'Paid',
        },
      )
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
   *
   * Also PERSISTS the SLA breach record here (story BM-012 — "the delivery is
   * eventually completed"): computed once, from the four real timestamps, and
   * written only if not already breached. Because reassign() (below) never
   * touches these timestamps, this computation — and the record it writes —
   * is unaffected by any reassignment that happened along the way ("the
   * original SLA breach is not erased").
   */
  async deliver(principal: Principal, id: string): Promise<ServiceRequest> {
    const branchIds = this.requireBranches(principal);

    // 1. Load, scoped to the caller's branch(es). Out-of-scope / soft-deleted /
    //    unknown ids all 404 — same as findById (AGENTS.md §5).
    const serviceRequest = await this.serviceRequests.findOne({
      where: { id, branchId: In(branchIds), deletedAt: IsNull() },
    });
    if (!serviceRequest) throw new NotFoundException('Service request not found');

    // Delivery and loyalty credit are deliberately retryable together. If the
    // delivery row committed but the post-commit loyalty write failed, retrying
    // this endpoint repairs the idempotent ledger entry instead of stranding it.
    if (serviceRequest.deliveredAt && serviceRequest.status === 'Delivered') {
      await this.recordDeliveredPurchase(serviceRequest);
      return serviceRequest;
    }

    // 2 + 3. Commit atomically: only a request that is out for delivery
    //    (dispatched, not yet delivered) is updated. 0 rows affected means the
    //    request is not out for delivery (still Pending, already Delivered, or
    //    Cancelled) — or a concurrent deliver already won — so treat it as the
    //    conflict, mirroring the dispatch race guard (AGENTS.md §8.2).
    const now = new Date();
    const deliverySet: Partial<ServiceRequest> = {
      deliveredAt: now,
      status: 'Delivered',
      updatedAt: now,
    };
    if (serviceRequest.paymentMethod === 'Cash on Delivery') {
      // Same-row UPDATE makes delivery confirmation and Cash receipt one
      // atomic database transition (CU-017 AC6).
      deliverySet.paymentStatus = 'Paid';
      deliverySet.paymentPaidAt = now;
    }
    const result = await this.serviceRequests
      .createQueryBuilder()
      .update(ServiceRequest)
      .set(deliverySet)
      .where(
        `id = :id
          AND branch_id = :branchId
          AND dispatched_at IS NOT NULL
          AND delivered_at IS NULL`,
        { id, branchId: serviceRequest.branchId },
      )
      .execute();
    if (!result.affected) {
      const concurrentlyDelivered = await this.serviceRequests.findOne({
        where: { id, branchId: In(branchIds), deletedAt: IsNull() },
      });
      if (concurrentlyDelivered?.deliveredAt && concurrentlyDelivered.status === 'Delivered') {
        await this.recordDeliveredPurchase(concurrentlyDelivered);
        return concurrentlyDelivered;
      }
      throw new ConflictException('Service request is not out for delivery');
    }

    // 4. Return the assigned rider to the Available roster (inverse of dispatch's
    //    markOnDelivery). rider_id is always set on an out-for-delivery request,
    //    but guard defensively in case of legacy data. Best-effort: a vehicle
    //    lookup failure must never block the delivery itself — the rider can be
    //    reset manually or on the next deliver attempt.
    if (serviceRequest.riderId) {
      try {
        await this.fleet.markAvailable(serviceRequest.riderId);
      } catch {
        // Non-fatal — the delivery committed; the rider may need a manual reset.
      }
    }

    // Reflect the committed state back to the caller without a re-read.
    serviceRequest.deliveredAt = now;
    serviceRequest.status = 'Delivered';
    serviceRequest.updatedAt = now;
    if (serviceRequest.paymentMethod === 'Cash on Delivery') {
      serviceRequest.paymentStatus = 'Paid';
      serviceRequest.paymentPaidAt = now;
    }

    // 5. Persist the SLA breach record (BM-012), using the now-complete four
    //    timestamps. Best-effort: a threshold lookup failure must never block
    //    the delivery itself, so this runs after the commit and swallows its
    //    own errors.
    try {
      const breach = await this.computeBreach(serviceRequest);
      if (breach) {
        await this.serviceRequests.update(
          { id },
          {
            slaBreached: true,
            slaBreachSegment: breach.segment,
            slaBreachedAt: now,
          },
        );
        serviceRequest.slaBreached = true;
        serviceRequest.slaBreachSegment = breach.segment;
        serviceRequest.slaBreachedAt = now;
      }
    } catch {
      // Non-fatal — the delivery itself already committed successfully.
    }

    // 6. Credit exactly one server-owned loyalty track for a linked customer.
    await this.recordDeliveredPurchase(serviceRequest);

    return serviceRequest;
  }

  private async recordDeliveredPurchase(serviceRequest: ServiceRequest): Promise<void> {
    if (!serviceRequest.customerId) return;
    await this.loyalty.recordDeliveredPurchase(
      serviceRequest.customerId,
      serviceRequest.branchId,
      serviceRequest.id,
      serviceRequest.cylinderSize,
      serviceRequest.quantity,
    );
  }

  /**
   * Replace the assigned rider on a delayed, still-in-flight request (story
   * BM-010). Interpretation call (stated in the PR): this does NOT touch
   * dispatched_at / in_transit_at — it only swaps the rider and writes an
   * audit entry. The story's bold AC title says "new dispatched_at segment
   * logged", but its actual Given/When/Then only requires "the system logs
   * the reassignment event with a timestamp" (which the audit row satisfies).
   * Taking the literal, testable clause over the loose title also means the
   * original SLA timing — and therefore the eventual persisted breach record
   * (BM-012) — is never disturbed by a reassignment, satisfying "the original
   * SLA breach is not erased" by construction rather than by extra logic.
   *
   * Order of checks (all in the service layer, AGENTS.md §5/§6):
   *  1. Load the SR scoped to the caller's branches — 404 if missing.
   *  2. Must be Dispatched/En Route with a currently assigned rider — else 400
   *     (nothing to reassign: still Pending, already Delivered, or Cancelled).
   *  3. The CURRENT rider is looked up status-agnostically (they are 'On
   *     Delivery', not 'Available') to name them in the audit note.
   *  4. The NEW rider must be Available, in the same branch, and different
   *     from the current rider — else 400.
   *  5. Commit atomically: conditional UPDATE (WHERE rider_id = the OLD rider
   *     AND status still Dispatched/En Route). 0 rows => a concurrent
   *     reassign/deliver already won => 409.
   *  6. Free the old rider ('Available'), claim the new one ('On Delivery').
   *  7. Append an audit entry naming both riders.
   */
  async reassign(
    principal: Principal,
    id: string,
    dto: ReassignServiceRequestDto,
  ): Promise<ServiceRequest> {
    const branchIds = this.requireBranches(principal);

    // 1. Load, scoped to the caller's branch(es).
    const serviceRequest = await this.serviceRequests.findOne({
      where: { id, branchId: In(branchIds), deletedAt: IsNull() },
    });
    if (!serviceRequest) throw new NotFoundException('Service request not found');

    // 2. Must be out for delivery with a rider already assigned.
    if (
      !['Dispatched', 'En Route'].includes(serviceRequest.status) ||
      !serviceRequest.riderId
    ) {
      throw new BadRequestException(
        'Cannot reassign: request is not out for delivery',
      );
    }
    const oldRiderId = serviceRequest.riderId;

    // 3. Name the current rider for the audit note (status-agnostic lookup —
    //    they are 'On Delivery', so findAssignableRider would not find them).
    const oldRider = await this.fleet.findInBranch(oldRiderId, serviceRequest.branchId);

    // 4. The new rider must be Available, in-branch, and a genuine change.
    if (dto.riderId === oldRiderId) {
      throw new BadRequestException('Request is already assigned to this rider');
    }
    const newRider = await this.fleet.findAssignableRider(
      dto.riderId,
      serviceRequest.branchId,
    );
    if (!newRider) throw new BadRequestException('Rider is not assignable');

    // 5. Commit atomically: only a still-out-for-delivery request currently
    //    assigned to the OLD rider is updated. 0 rows => a concurrent
    //    reassign or deliver already won => 409.
    const now = new Date();
    const result = await this.serviceRequests
      .createQueryBuilder()
      .update(ServiceRequest)
      .set({ riderId: newRider.id, updatedAt: now })
      .where(
        'id = :id AND rider_id = :oldRiderId AND status IN (:...statuses)',
        { id, oldRiderId, statuses: ['Dispatched', 'En Route'] },
      )
      .execute();
    if (!result.affected) {
      throw new ConflictException('Request is no longer assigned to that rider');
    }

    // 6. Swap fleet availability: free the old rider, claim the new one.
    //    markAvailable is best-effort — a vehicle-lookup failure must not prevent
    //    the new rider from being claimed (the old rider can be reset manually).
    try {
      await this.fleet.markAvailable(oldRiderId);
    } catch {
      // Non-fatal — the old rider may remain On Delivery; manual reset possible.
    }
    await this.fleet.markOnDelivery(newRider.id);

    // 7. Audit the reassignment. Status is unchanged (see the interpretation
    //    note above), so from/to are both the request's current status.
    await this.statusHistory.save(
      this.statusHistory.create({
        serviceRequestId: id,
        branchId: serviceRequest.branchId,
        fromStatus: serviceRequest.status,
        toStatus: serviceRequest.status,
        changedBy: principal.userId,
        changedAt: now,
        note: `Reassigned from ${oldRider?.name ?? oldRiderId} to ${newRider.name}`,
      }),
    );

    // Reflect the committed state back to the caller without a re-read.
    serviceRequest.riderId = newRider.id;
    serviceRequest.updatedAt = now;
    return serviceRequest;
  }

  /**
   * Log a delay reason (story BM-011). The dropdown category + optional
   * free-text note are combined into the single `delay_reason` display
   * string. No status change — this is purely documentation, available on any
   * still-in-flight request (Pending/Dispatched/En Route); once Delivered or
   * Cancelled the delivery outcome already speaks for itself, and once Under
   * Review a lost-cylinder complaint (BM-US-04) already documents the issue.
   */
  async logDelayReason(
    principal: Principal,
    id: string,
    dto: LogDelayReasonDto,
  ): Promise<ServiceRequest> {
    const branchIds = this.requireBranches(principal);

    const serviceRequest = await this.serviceRequests.findOne({
      where: { id, branchId: In(branchIds), deletedAt: IsNull() },
    });
    if (!serviceRequest) throw new NotFoundException('Service request not found');

    if (!['Pending', 'Dispatched', 'En Route'].includes(serviceRequest.status)) {
      throw new BadRequestException(
        `Cannot log a delay reason on a request that is ${serviceRequest.status}`,
      );
    }

    const label = DELAY_REASON_LABELS[dto.reasonCategory] ?? dto.reasonCategory;
    const note = dto.note?.trim();
    const delayReason = note ? `${label}: ${note}` : label;

    const now = new Date();
    await this.serviceRequests.update(
      { id },
      { delayReason, updatedAt: now },
    );
    await this.statusHistory.save(
      this.statusHistory.create({
        serviceRequestId: id,
        branchId: serviceRequest.branchId,
        fromStatus: serviceRequest.status,
        toStatus: serviceRequest.status,
        changedBy: principal.userId,
        changedAt: now,
        note: `Delay reason logged: ${delayReason}`,
      }),
    );

    serviceRequest.delayReason = delayReason;
    serviceRequest.updatedAt = now;
    return serviceRequest;
  }

  /**
   * Edit a pre-dispatch request (stories BM-034/035/037). Only the mutable order
   * details may change, and ONLY while the request is still Pending and not yet
   * dispatched — this is the whole point of the story: a Branch Manager can
   * correct an order right up until a rider is assigned, never after.
   *
   * Order of checks (all in the service layer, AGENTS.md §5/§6):
   *  1. Load the SR scoped to the caller's branches — 404 if missing,
   *     soft-deleted, or out of scope (never leak another branch's rows).
   *  2. Diff the requested changes against the loaded (OLD) values, so the audit
   *     note records exactly what changed and untouched fields are left alone.
   *  3. Pre-dispatch guard (real-time, race-safe): commit with a conditional
   *     UPDATE (WHERE still Pending / not dispatched / not deleted). 0 rows means
   *     the request was dispatched (or cancelled/deleted) between load and write
   *     — a concurrent dispatch won — so it is a 409, NOT a silent no-op
   *     (BM-034/BM-037: the check is at write time, not just on load).
   *  4. Append a status-history row summarising the old→new change (from and to
   *     status both 'Pending' — an edit is not a lifecycle transition). Written
   *     only when something actually changed, and only after the authoritative
   *     UPDATE succeeded, so a 409 leaves no audit noise.
   */
  async edit(
    principal: Principal,
    id: string,
    dto: EditServiceRequestDto,
  ): Promise<ServiceRequest> {
    const branchIds = this.requireBranches(principal);

    // 1. Load, scoped to the caller's branch(es). Out-of-scope / soft-deleted /
    //    unknown ids all 404 — same as findById (AGENTS.md §5).
    const serviceRequest = await this.serviceRequests.findOne({
      where: { id, branchId: In(branchIds), deletedAt: IsNull() },
    });
    if (!serviceRequest) throw new NotFoundException('Service request not found');

    if (
      serviceRequest.paymentMethod === 'PayMongo' &&
      serviceRequest.paymongoCheckoutSessionId
    ) {
      throw new ConflictException('Cannot edit after PayMongo checkout has started');
    }

    // 2. Diff against the OLD values. Only changed fields land in `set` (the
    //    UPDATE) and `changes` (the human-readable audit note). specialInstructions
    //    is normalised to null when blank so "" genuinely clears it.
    const set: Partial<ServiceRequest> = {};
    const changes: string[] = [];

    if (dto.deliveryAddress !== undefined) {
      const next = dto.deliveryAddress.trim();
      if (next !== serviceRequest.deliveryAddress) {
        changes.push(
          `delivery_address "${serviceRequest.deliveryAddress}" → "${next}"`,
        );
        set.deliveryAddress = next;
      }
    }
    if (dto.cylinderSize !== undefined) {
      const next = dto.cylinderSize.trim();
      if (next !== serviceRequest.cylinderSize) {
        changes.push(`cylinder_size "${serviceRequest.cylinderSize}" → "${next}"`);
        set.cylinderSize = next;
      }
    }
    if (dto.quantity !== undefined && dto.quantity !== serviceRequest.quantity) {
      changes.push(`quantity ${serviceRequest.quantity} → ${dto.quantity}`);
      set.quantity = dto.quantity;
    }
    if (dto.specialInstructions !== undefined) {
      const next = dto.specialInstructions.trim() || null;
      if (next !== serviceRequest.specialInstructions) {
        changes.push(
          `special_instructions ${this.quoteNullable(serviceRequest.specialInstructions)} → ${this.quoteNullable(next)}`,
        );
        set.specialInstructions = next;
      }
    }

    // 3. Commit atomically under the pre-dispatch guard. Even a no-op edit (all
    //    values unchanged) runs the guarded UPDATE so the pre-dispatch invariant
    //    is enforced at write time and updated_at is bumped. 0 rows affected =>
    //    the request is no longer editable (dispatched / cancelled / deleted).
    const now = new Date();
    const result = await this.serviceRequests
      .createQueryBuilder()
      .update(ServiceRequest)
      .set({ ...set, updatedAt: now })
      .where(
        'id = :id AND dispatched_at IS NULL AND status = :status AND deleted_at IS NULL',
        { id, status: 'Pending' },
      )
      .execute();
    if (!result.affected) {
      throw new ConflictException('Cannot edit: request already dispatched');
    }

    // 4. Audit the diff. An edit keeps the status Pending → Pending; the note
    //    carries the actual field changes. Skipped when nothing changed.
    if (changes.length > 0) {
      await this.statusHistory.save(
        this.statusHistory.create({
          serviceRequestId: id,
          branchId: serviceRequest.branchId,
          fromStatus: 'Pending',
          toStatus: 'Pending',
          changedBy: principal.userId,
          changedAt: now,
          note: `Edited: ${changes.join('; ')}`,
        }),
      );
    }

    // Reflect the committed state back to the caller without a re-read.
    Object.assign(serviceRequest, set);
    serviceRequest.updatedAt = now;
    return serviceRequest;
  }

  /**
   * Cancel a pre-dispatch request (story BM-036). Like edit, this is only valid
   * while the request is still Pending and not yet dispatched — once a rider is
   * assigned it is out of the Branch Manager's hands. Cancelling simply voids the
   * SLA clock: none of the four SLA timestamps are set (a cancelled order was
   * never delivered, so there is no leg to measure).
   *
   * Order of checks (all in the service layer, AGENTS.md §5/§6):
   *  1. Load the SR scoped to the caller's branches — 404 if missing,
   *     soft-deleted, or out of scope (never leak another branch's rows).
   *  2. Pre-dispatch guard (race-safe): conditional UPDATE flipping status to
   *     'Cancelled' (WHERE still Pending / not dispatched / not deleted). 0 rows
   *     => already dispatched (or cancelled/deleted) => 409.
   *  3. Append a status-history row: Pending → Cancelled, with the caller's
   *     reason recorded verbatim for accountability.
   *
   * PANEL-CHECK: BM-036 also calls for an in-app notification to the customer.
   * Customers are MOBILE-ONLY (AGENTS.md §7), so that notification is a mobile
   * concern and is deliberately NOT built here — out of scope for this backend.
   */
  async cancel(
    principal: Principal,
    id: string,
    dto: CancelServiceRequestDto,
  ): Promise<ServiceRequest> {
    const branchIds = this.requireBranches(principal);

    // 1. Load, scoped to the caller's branch(es). Out-of-scope / soft-deleted /
    //    unknown ids all 404 — same as findById (AGENTS.md §5).
    const serviceRequest = await this.serviceRequests.findOne({
      where: { id, branchId: In(branchIds), deletedAt: IsNull() },
    });
    if (!serviceRequest) throw new NotFoundException('Service request not found');

    if (
      serviceRequest.paymentMethod === 'PayMongo' &&
      serviceRequest.paymentStatus === 'Paid'
    ) {
      throw new ConflictException('Paid PayMongo Service Requests cannot be cancelled');
    }
    if (
      serviceRequest.paymentMethod === 'PayMongo' &&
      serviceRequest.paymongoCheckoutSessionId
    ) {
      await this.payMongo.expireCheckout(serviceRequest.paymongoCheckoutSessionId);
    }

    // 2. Commit atomically under the pre-dispatch guard. 0 rows affected means
    //    the request was dispatched (or already cancelled/deleted) between load
    //    and write — treat as the conflict, mirroring dispatch/deliver.
    const now = new Date();
    const result = await this.serviceRequests
      .createQueryBuilder()
      .update(ServiceRequest)
      .set({ status: 'Cancelled', updatedAt: now })
      .where(
        `id = :id
          AND branch_id = :branchId
          AND dispatched_at IS NULL
          AND status = :status
          AND deleted_at IS NULL
          AND payment_status <> :paid`,
        {
          id,
          branchId: serviceRequest.branchId,
          status: 'Pending',
          paid: 'Paid',
        },
      )
      .execute();
    if (!result.affected) {
      throw new ConflictException('Cannot cancel: request already dispatched');
    }

    // 3. Audit the transition with the caller's reason.
    await this.statusHistory.save(
      this.statusHistory.create({
        serviceRequestId: id,
        branchId: serviceRequest.branchId,
        fromStatus: 'Pending',
        toStatus: 'Cancelled',
        changedBy: principal.userId,
        changedAt: now,
        note: dto.reason,
      }),
    );

    // Reflect the committed state back to the caller without a re-read.
    serviceRequest.status = 'Cancelled';
    serviceRequest.updatedAt = now;
    return serviceRequest;
  }

  /**
   * Batch-resolve active 'all'-channel SLA thresholds for a set of branches,
   * one query for branch-specific rows + one for the global (branch_id NULL)
   * fallback — avoids an N+1 lookup per row in listWithSlaRisk. A branch with
   * no specific override falls back to the global row per segment.
   */
  private async resolveThresholdsForBranches(
    branchIds: string[],
  ): Promise<Map<string, ThresholdMap>> {
    const [branchRows, globalRows] = await Promise.all([
      this.slaConfigurations.find({
        where: { branchId: In(branchIds), orderSource: 'all', isActive: true },
      }),
      this.slaConfigurations.find({
        where: { branchId: IsNull(), orderSource: 'all', isActive: true },
      }),
    ]);

    const globalMap: ThresholdMap = {};
    for (const row of globalRows) globalMap[row.segment] = row.thresholdMinutes;

    const result = new Map<string, ThresholdMap>();
    for (const branchId of branchIds) {
      result.set(branchId, { ...globalMap });
    }
    for (const row of branchRows) {
      const map = result.get(row.branchId as string);
      if (map) map[row.segment] = row.thresholdMinutes;
    }
    return result;
  }

  private emptySlaMetric(): SlaReportMetric {
    return { evaluated: 0, compliant: 0, breached: 0, complianceRate: null };
  }

  private recordSlaOutcome(metric: SlaReportMetric, compliant: boolean): void {
    metric.evaluated += 1;
    if (compliant) metric.compliant += 1;
    else metric.breached += 1;
  }

  private finishSlaMetric(metric: SlaReportMetric): void {
    metric.complianceRate = this.complianceRate(metric.compliant, metric.evaluated);
  }

  private complianceRate(compliant: number, evaluated: number): number | null {
    return evaluated === 0 ? null : Number(((compliant / evaluated) * 100).toFixed(1));
  }

  private minutesBetween(from: Date, to: Date): number {
    return (to.getTime() - from.getTime()) / 60_000;
  }

  /**
   * LIVE at-risk check for one still-in-flight request (BM-008). See
   * listWithSlaRisk's doc for the Dispatched≈En Route interpretation.
   * Delivered/Cancelled/Under Review rows are never "at risk" — their outcome
   * is already final; the permanent breach record (if any) lives on the row.
   */
  private computeAtRisk(
    sr: ServiceRequest,
    thresholds: ThresholdMap,
    now: Date,
  ): { atRisk: boolean; segment: SlaSegment | null } {
    const minutesSince = (from: Date) => (now.getTime() - from.getTime()) / 60000;

    if (sr.status === 'Pending') {
      const threshold = thresholds.request_to_dispatch;
      if (threshold == null) return { atRisk: false, segment: null };
      return {
        atRisk: minutesSince(sr.requestedAt) > threshold,
        segment: 'request_to_dispatch',
      };
    }

    if (sr.status === 'Dispatched' || sr.status === 'En Route') {
      // in_transit_at is GPS-dependent and typically null in this MVP
      // (AGENTS.md §8) — when present, check the finer in-transit segment;
      // otherwise fall back to the coarser dispatch segment using
      // dispatched_at, which is always set once out for delivery.
      if (sr.inTransitAt) {
        const threshold = thresholds.in_transit_to_delivery;
        if (threshold == null) return { atRisk: false, segment: null };
        return {
          atRisk: minutesSince(sr.inTransitAt) > threshold,
          segment: 'in_transit_to_delivery',
        };
      }
      const threshold = thresholds.dispatch_to_in_transit;
      if (threshold == null || !sr.dispatchedAt) return { atRisk: false, segment: null };
      return {
        atRisk: minutesSince(sr.dispatchedAt) > threshold,
        segment: 'dispatch_to_in_transit',
      };
    }

    return { atRisk: false, segment: null };
  }

  /**
   * PERSISTED breach computation at delivery (BM-012), using the four real
   * timestamps. Segment 1 (request_to_dispatch) is always measurable. When
   * in_transit_at was never populated (typical for this MVP — GPS deferred,
   * AGENTS.md §8), segments 2/3 cannot be individually attributed without it,
   * so this checks the 'end_to_end' threshold (dispatched_at → delivered_at)
   * as the honest fallback instead of guessing at segment attribution —
   * interpretation call, stated in the PR. Returns the FIRST segment found in
   * breach (chronological order), or null if none breached / no threshold is
   * configured for the relevant segment(s).
   */
  private async computeBreach(
    sr: ServiceRequest,
  ): Promise<{ segment: SlaSegment } | null> {
    const thresholds = (await this.resolveThresholdsForBranches([sr.branchId])).get(
      sr.branchId,
    ) ?? {};
    const minutesBetween = (from: Date, to: Date) => (to.getTime() - from.getTime()) / 60000;

    if (!sr.dispatchedAt || !sr.deliveredAt) return null;

    // Segment 1: request → dispatch. Always measurable.
    const seg1 = thresholds.request_to_dispatch;
    if (seg1 != null && minutesBetween(sr.requestedAt, sr.dispatchedAt) > seg1) {
      return { segment: 'request_to_dispatch' };
    }

    if (sr.inTransitAt) {
      // GPS data present: check segments 2 and 3 individually.
      const seg2 = thresholds.dispatch_to_in_transit;
      if (seg2 != null && minutesBetween(sr.dispatchedAt, sr.inTransitAt) > seg2) {
        return { segment: 'dispatch_to_in_transit' };
      }
      const seg3 = thresholds.in_transit_to_delivery;
      if (seg3 != null && minutesBetween(sr.inTransitAt, sr.deliveredAt) > seg3) {
        return { segment: 'in_transit_to_delivery' };
      }
      return null;
    }

    // No GPS data: fall back to the combined dispatch→delivery span against
    // the end_to_end threshold.
    const endToEnd = thresholds.end_to_end;
    if (endToEnd != null && minutesBetween(sr.dispatchedAt, sr.deliveredAt) > endToEnd) {
      return { segment: 'end_to_end' };
    }
    return null;
  }

  /** Render a nullable string for an audit note: quoted value, or (none). */
  private quoteNullable(value: string | null): string {
    return value === null ? '(none)' : `"${value}"`;
  }

  /** The caller's active branch UUIDs; fails closed if they have none. */
  private requireBranches(principal: Principal): string[] {
    if (principal.branchIds.length === 0) {
      throw new ForbiddenException('Caller has no active branch');
    }
    return principal.branchIds;
  }

  /** A client value can narrow verified JWT scope, never widen it. */
  private reportBranchIds(principal: Principal, requestedBranchId?: string): string[] {
    const branchIds = this.requireBranches(principal);
    if (!requestedBranchId) return branchIds;
    if (!branchIds.includes(requestedBranchId)) {
      throw new ForbiddenException('Requested branch is outside the caller scope');
    }
    return [requestedBranchId];
  }

  /** The single branch a new request is filed under — the caller's own branch. */
  private requireBranch(principal: Principal): string {
    return this.requireBranches(principal)[0];
  }
}
