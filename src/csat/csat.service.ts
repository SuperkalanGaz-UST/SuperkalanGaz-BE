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
  DataSource,
  In,
  IsNull,
  LessThan,
  LessThanOrEqual,
  MoreThanOrEqual,
  Repository,
} from 'typeorm';
import { Principal } from '../auth/principal';
import { BranchReportQuery } from '../common/dto/branch-report.query';
import { reportRangeFrom } from '../common/report-range';
import { Rating } from './rating.entity';
import { Incident } from './incident.entity';
import { ServiceRequest } from '../service-requests/service-request.entity';
import { Rider } from '../fleet/rider.entity';
import { ListRatingsQuery } from './dto/list-ratings.query';
import { ResolveRatingDto } from './dto/resolve-rating.dto';
import { CreateIncidentDto } from './dto/create-incident.dto';
import { ListIncidentsQuery } from './dto/list-incidents.query';
import { CreateRatingDto } from './dto/create-rating.dto';

/** Service Request statuses a complaint may be logged against (BM-US-04 AC1:
 * "any closed or active Service Request"). Interpreted as Dispatched/En Route
 * (active — a delivery is under way) or Delivered (closed — completed); Pending
 * is excluded (nothing has been dispatched to lose yet) and Cancelled is excluded
 * (no cylinder was ever in transit). Stated as an interpretation call in the PR. */
const COMPLAINT_ELIGIBLE_STATUSES = ['Dispatched', 'En Route', 'Delivered'];

/** The Service Request status a complaint submission sets (story BM-021,
 * consolidated AC3's literal value — see the PR for why this was chosen over
 * the granular story's hedged "e.g. Incident Flagged or Disputed"). */
const UNDER_REVIEW_STATUS = 'Under Review';

/** The low-CSAT band the Branch Manager follow-up queue surfaces by default
 * (story BM-038: "deliveries with 1–3 star ratings"). */
const LOW_CSAT_MAX_STARS = 3;

/**
 * A rating enriched for the follow-up queue: the rating plus the delivery context
 * the Branch Manager needs to act without a second round-trip (story BM-039 —
 * the associated Service Request detail, its four SLA timestamps, and the rider
 * who delivered it). The controller flattens this into the snake_case row.
 */
export interface RatingListItem {
  rating: Rating;
  customerName: string | null;
  serviceRequest: ServiceRequest | null;
  riderName: string | null;
}

/** Branch CSAT KPIs (story BM-041: the Open Complaints count the BM watches
 * decrement, alongside the headline average). */
export interface CsatSummary {
  openCount: number;
  resolvedCount: number;
  lowCsatOpenCount: number;
  averageStars: number | null;
  totalRatings: number;
}

export interface CsatBranchReport {
  averageStars: number | null;
  totalResponses: number;
  deliveredRequests: number;
  responseRate: number | null;
  incidentsRaised: number;
  ratingDistribution: Record<1 | 2 | 3 | 4 | 5, number>;
}

/**
 * An incident enriched for the Branch Manager's review (journey BM-US-04): the
 * complaint plus the customer name and the associated Service Request context,
 * the same shape RatingListItem carries for BM-039. The controller flattens this
 * into the snake_case row.
 */
export interface IncidentListItem {
  incident: Incident;
  customerName: string | null;
  serviceRequest: ServiceRequest | null;
  riderName: string | null;
}

/**
 * CSAT Feedback & Analytics module — two Branch Manager follow-up flows plus
 * the Branch Owner's read-only branch report:
 *  - closed-loop follow-up on low-rated deliveries (journey BM-US-08). Ratings
 *    are submitted by CUSTOMERS on mobile (AGENTS.md §7); this service never
 *    creates them, only reads and resolves them.
 *  - logging a lost/undelivered cylinder complaint against a delivery (journey
 *    BM-US-04). Unlike ratings, incidents ARE created here — by the Branch
 *    Manager, not the customer — and the write is transactional with flipping
 *    the linked Service Request's status to 'Under Review'.
 *
 * All scoping derives from the verified Principal, never from request input
 * (AGENTS.md §5). Isolation is enforced here in the application layer, not by the
 * DB — a missing branch filter is a cross-tenant leak. State transitions use
 * race-safe conditional UPDATEs.
 */
@Injectable()
export class CsatService {
  constructor(
    @InjectRepository(Rating)
    private readonly ratings: Repository<Rating>,
    @InjectRepository(Incident)
    private readonly incidents: Repository<Incident>,
    @InjectRepository(ServiceRequest)
    private readonly serviceRequests: Repository<ServiceRequest>,
    @InjectRepository(Rider)
    private readonly riders: Repository<Rider>,
    // The complaint-logging transaction spans two tables (incidents + the linked
    // Service Request's status), so it needs a transaction that covers both.
    private readonly dataSource: DataSource,
  ) {}

  /**
   * The follow-up queue (story BM-038): ratings for the caller's branch(es),
   * newest first, defaulting to the low-CSAT band (<= 3 stars) and Open entries —
   * i.e. exactly what still needs actioning. Each row is enriched with the
   * customer name and the associated Service Request + rider so the BM can review
   * the delivery context inline (story BM-039).
   */
  async listRatings(
    principal: Principal,
    query: ListRatingsQuery,
  ): Promise<RatingListItem[]> {
    const branchIds = this.requireBranches(principal);

    // Only filter by star range if explicitly requested. When maxStars is
    // omitted the caller wants the full picture (e.g. the "All" view on the
    // BM CSAT screen). The frontend checkbox sends maxStars=2 when the user
    // ticks "Low CSAT only" — the service must not impose its own default here.
    const resolution = query.resolution ?? 'Open';

    const ratings = await this.ratings.find({
      where: {
        branchId: In(branchIds),
        ...(query.maxStars != null
          ? { stars: LessThanOrEqual(query.maxStars) }
          : {}),
        ...(resolution === 'all' ? {} : { resolutionStatus: resolution }),
      },
      order: { submittedAt: 'DESC' },
      take: 200,
    });
    if (ratings.length === 0) return [];

    // Batch-resolve the enrichments in bulk (no per-row N+1), all branch-scoped.
    const customerIds = [...new Set(ratings.map((r) => r.customerId))];
    const serviceRequestIds = [...new Set(ratings.map((r) => r.serviceRequestId))];

    const [customerNames, serviceRequests] = await Promise.all([
      this.customerNames(branchIds, customerIds),
      this.serviceRequests.find({
        where: { id: In(serviceRequestIds), branchId: In(branchIds) },
      }),
    ]);
    const srById = new Map(serviceRequests.map((sr) => [sr.id, sr]));

    // Riders come from the resolved Service Requests, so look them up after.
    const riderIds = [
      ...new Set(
        serviceRequests
          .map((sr) => sr.riderId)
          .filter((id): id is string => id !== null),
      ),
    ];
    const riderNames = await this.riderNames(branchIds, riderIds);

    return ratings.map((rating) => {
      const sr = srById.get(rating.serviceRequestId) ?? null;
      return {
        rating,
        customerName: customerNames.get(rating.customerId) ?? null,
        serviceRequest: sr,
        riderName: sr?.riderId ? (riderNames.get(sr.riderId) ?? null) : null,
      };
    });
  }

  /**
   * Submit a customer rating for a completed delivery. Called from the mobile
   * app after delivery (customer role only). Validates that:
   *  (a) the Service Request exists and belongs to the authenticated customer;
   *  (b) the SR is in 'Delivered' status — only completed deliveries can be rated;
   *  (c) no rating already exists for this SR (idempotent guard → 409 on duplicate).
   *
   * The branch_id is derived from the Service Request, never trusted from the
   * client (AGENTS.md §5). submitted_at and created_at are stamped server-side.
   */
  async submitRating(
    principal: Principal,
    dto: CreateRatingDto,
  ): Promise<Rating> {
    if (principal.role !== 'customer') {
      throw new ForbiddenException('Only customers may submit ratings');
    }

    // Resolve the CIM profile UUIDs for this auth user. The SR's customer_id
    // is the CIM customer profile UUID, NOT the raw Supabase auth user id.
    // We include the auth userId itself as a fallback for legacy orders written
    // before migration 0025 synced mobile customers into CIM — exactly the same
    // approach listForCustomer uses.
    const profileRows = await this.ratings.manager
      .createQueryBuilder()
      .select('c.id', 'id')
      .from('cim.customers', 'c')
      .where('c.auth_user_id = :authUserId', { authUserId: principal.userId })
      .andWhere('c.deleted_at IS NULL')
      .getRawMany<{ id: string }>();
    const ownedCustomerIds = [
      ...new Set([principal.userId, ...profileRows.map((r) => r.id)]),
    ];

    // (a) Locate the service request owned by this customer.
    const sr = await this.serviceRequests.findOne({
      where: { id: dto.serviceRequestId, customerId: In(ownedCustomerIds) },
    });
    if (!sr) {
      throw new NotFoundException('Order not found');
    }

    // (b) Only Delivered orders can be rated.
    if (sr.status !== 'Delivered') {
      throw new BadRequestException(
        'Only delivered orders can be rated. This order is currently ' + sr.status,
      );
    }

    // (c) Duplicate guard — one rating per order.
    const existing = await this.ratings.findOne({
      where: { serviceRequestId: dto.serviceRequestId },
    });
    if (existing) {
      throw new ConflictException('This order has already been rated');
    }

    const now = new Date();
    const rating = this.ratings.create({
      branchId: sr.branchId,
      serviceRequestId: sr.id,
      // Store the SR's actual customer_id (the CIM UUID) so CSAT queries
      // that join on customer_id work correctly downstream.
      customerId: sr.customerId ?? principal.userId,
      stars: dto.stars,
      comment: dto.comment ?? null,
      submittedAt: now,
      createdAt: now,
      resolutionStatus: dto.stars <= LOW_CSAT_MAX_STARS ? 'Open' : 'Resolved',
      resolutionNote: null,
      resolvedBy: null,
      resolvedAt: null,
    });

    return this.ratings.save(rating);
  }

  /**
   * Close the loop on a rating (stories BM-040 + BM-041): record the Branch
   * Manager's resolution note and mark it Resolved, stamping who and when. The
   * note and the status change are ONE action — BM-041 requires the note to exist
   * before a complaint counts as addressed, so there is no note-less resolve.
   *
   * The Open→Resolved transition is race-safe: 0 rows affected (already resolved,
   * or a concurrent resolve won) => 409. Out-of-branch / unknown ids 404.
   */
  async resolveRating(
    principal: Principal,
    id: string,
    dto: ResolveRatingDto,
  ): Promise<Rating> {
    const branchIds = this.requireBranches(principal);

    const rating = await this.ratings.findOne({
      where: { id, branchId: In(branchIds) },
    });
    if (!rating) throw new NotFoundException('Rating not found');

    const now = new Date();
    const result = await this.ratings
      .createQueryBuilder()
      .update(Rating)
      .set({
        resolutionStatus: 'Resolved',
        resolutionNote: dto.note,
        resolvedBy: principal.userId,
        resolvedAt: now,
      })
      .where(
        'id = :id AND branch_id IN (:...branchIds) AND resolution_status = :status',
        { id, branchIds, status: 'Open' },
      )
      .execute();
    if (!result.affected) {
      throw new ConflictException('Rating is already resolved');
    }

    // Reflect the committed state back to the caller without a re-read.
    rating.resolutionStatus = 'Resolved';
    rating.resolutionNote = dto.note;
    rating.resolvedBy = principal.userId;
    rating.resolvedAt = now;
    return rating;
  }

  /**
   * Branch CSAT KPIs (story BM-041). openCount is the "Open Complaints" figure
   * the BM watches decrement on resolve; lowCsatOpenCount narrows that to the
   * 1–3 star band the follow-up queue actually shows. averageStars is the
   * headline satisfaction figure, null when the branch has no ratings yet.
   */
  async getSummary(principal: Principal): Promise<CsatSummary> {
    const branchIds = this.requireBranches(principal);

    const rows = await this.ratings.find({
      where: { branchId: In(branchIds) },
      select: { id: true, stars: true, resolutionStatus: true },
    });

    return this.summarizeRatings(rows);
  }

  /** Same rating aggregation as the BM summary, narrowed to one owned branch. */
  async getSummaryForBranch(principal: Principal, branchId: string): Promise<CsatSummary> {
    const [authorizedBranchId] = this.reportBranchIds(principal, branchId);
    const rows = await this.ratings.find({
      where: { branchId: authorizedBranchId },
      select: { id: true, stars: true, resolutionStatus: true },
    });

    return this.summarizeRatings(rows);
  }

  private summarizeRatings(rows: Array<Pick<Rating, 'id' | 'stars' | 'resolutionStatus'>>): CsatSummary {

    // "Open Complaints" = complaint-band (≤2★) Open ratings the BM must act on.
    // 3–5★ ratings are auto-resolved at submission, but guard here too for any
    // legacy rows created before that rule was introduced.
    const openCount = rows.filter(
      (r) => r.resolutionStatus === 'Open' && r.stars <= LOW_CSAT_MAX_STARS,
    ).length;
    const lowCsatOpenCount = openCount; // same definition, kept for API compat
    const resolvedCount = rows.length - openCount;

    return {
      openCount,
      resolvedCount,
      lowCsatOpenCount,
      averageStars: rows.length
        ? Number((rows.reduce((sum, r) => sum + r.stars, 0) / rows.length).toFixed(2))
        : null,
      totalRatings: rows.length,
    };
  }

  /**
   * Read-only Branch Owner CSAT report. Ratings are tied to deliveries completed
   * in the selected period, which keeps the response-rate denominator honest
   * when a customer submits feedback a day or two after delivery.
   */
  async getBranchReport(
    principal: Principal,
    query: BranchReportQuery,
  ): Promise<CsatBranchReport> {
    const branchIds = this.reportBranchIds(principal, query.branchId);
    const { start, endExclusive } = reportRangeFrom(query);

    const deliveries = await this.serviceRequests.find({
      where: {
        branchId: In(branchIds),
        deliveredAt: And(MoreThanOrEqual(start), LessThan(endExclusive)),
        deletedAt: IsNull(),
      },
      select: { id: true },
    });
    const deliveryIds = deliveries.map((delivery) => delivery.id);

    const [ratings, incidentsRaised] = await Promise.all([
      deliveryIds.length === 0
        ? Promise.resolve([] as Rating[])
        : this.ratings.find({
            where: {
              branchId: In(branchIds),
              serviceRequestId: In(deliveryIds),
            },
            select: { id: true, stars: true },
          }),
      this.incidents.count({
        where: {
          branchId: In(branchIds),
          reportedAt: And(MoreThanOrEqual(start), LessThan(endExclusive)),
        },
      }),
    ]);

    const ratingDistribution: CsatBranchReport['ratingDistribution'] = {
      1: 0,
      2: 0,
      3: 0,
      4: 0,
      5: 0,
    };
    for (const rating of ratings) ratingDistribution[rating.stars as 1 | 2 | 3 | 4 | 5] += 1;

    return {
      averageStars: ratings.length
        ? Number((ratings.reduce((sum, rating) => sum + rating.stars, 0) / ratings.length).toFixed(2))
        : null,
      totalResponses: ratings.length,
      deliveredRequests: deliveries.length,
      responseRate: deliveries.length
        ? Number(((ratings.length / deliveries.length) * 100).toFixed(1))
        : null,
      incidentsRaised,
      ratingDistribution,
    };
  }

  /**
   * Log a complaint against a delivery (journey BM-US-04, stories BM-019/020/021
   * combined into one atomic action). Locating the SR (BM-019) is done by the
   * caller via the existing Orders queue — this method just validates the id it
   * receives. The free-text description doubles as BM-020's "resolution note".
   *
   * TRANSACTIONAL — mutates two tables atomically:
   *  (a) insert the csat.incidents row (status='open', priority='medium').
   *  (b) flip the linked Service Request's status to 'Under Review' (BM-021),
   *      race-safe: 0 rows affected (already actioned by a concurrent request,
   *      or the SR moved out of the eligible-status set) => 409, rolls back.
   *
   * Integrity checks in the service layer (no FK constraints, AGENTS.md §6):
   *  - the Service Request must exist in the caller's own branch — else 404;
   *  - it must be Dispatched, En Route, or Delivered — "closed or active" per
   *    BM-US-04 AC1 (interpretation call — see the PR) — else 400.
   */
  async createIncident(
    principal: Principal,
    dto: CreateIncidentDto,
  ): Promise<Incident> {
    const branchIds = this.requireBranches(principal);

    return this.dataSource.transaction(async (manager) => {
      const sr = await manager.findOne(ServiceRequest, {
        where: { id: dto.serviceRequestId, branchId: In(branchIds) },
      });
      if (!sr) throw new NotFoundException('Service request not found');
      if (!COMPLAINT_ELIGIBLE_STATUSES.includes(sr.status)) {
        throw new BadRequestException(
          `Cannot log a complaint against a service request that is ${sr.status}`,
        );
      }

      const now = new Date();
      const incident = await manager.save(
        Incident,
        manager.create(Incident, {
          branchId: sr.branchId,
          customerId: sr.customerId,
          serviceRequestId: sr.id,
          category: dto.category,
          description: dto.description,
          status: 'open',
          priority: 'medium',
          reportedAt: now,
          firstResponseAt: null,
          resolvedAt: null,
          assignedTo: null,
          resolutionNote: null,
          escalated: false,
          escalatedAt: null,
          createdAt: now,
          updatedAt: now,
        }),
      );

      // (b) Race-safe: only flip status if the SR is still in an eligible state —
      // re-validated at commit time, not just at the read above (AGENTS.md §8a).
      const updated = await manager
        .createQueryBuilder()
        .update(ServiceRequest)
        .set({ status: UNDER_REVIEW_STATUS, updatedAt: now })
        .where(
          'id = :id AND branch_id IN (:...branchIds) AND status IN (:...eligible)',
          { id: sr.id, branchIds, eligible: COMPLAINT_ELIGIBLE_STATUSES },
        )
        .execute();
      if (!updated.affected) {
        throw new ConflictException(
          'Service request status changed before the complaint could be logged',
        );
      }

      return incident;
    });
  }

  /**
   * The Branch Manager's incident queue: complaints for the caller's branch(es),
   * newest first, defaulting to 'open'. Each row is enriched with the customer
   * name and the associated Service Request + rider, the same context BM-039
   * provides for ratings.
   */
  async listIncidents(
    principal: Principal,
    query: ListIncidentsQuery,
  ): Promise<IncidentListItem[]> {
    const branchIds = this.requireBranches(principal);
    const status = query.status ?? 'open';

    const incidents = await this.incidents.find({
      where: {
        branchId: In(branchIds),
        ...(status === 'all' ? {} : { status }),
      },
      order: { reportedAt: 'DESC' },
      take: 200,
    });
    if (incidents.length === 0) return [];

    const customerIds = [
      ...new Set(
        incidents.map((i) => i.customerId).filter((id): id is string => id !== null),
      ),
    ];
    const serviceRequestIds = [
      ...new Set(
        incidents
          .map((i) => i.serviceRequestId)
          .filter((id): id is string => id !== null),
      ),
    ];

    const [customerNames, serviceRequests] = await Promise.all([
      this.customerNames(branchIds, customerIds),
      this.serviceRequests.find({
        where: { id: In(serviceRequestIds), branchId: In(branchIds) },
      }),
    ]);
    const srById = new Map(serviceRequests.map((sr) => [sr.id, sr]));

    const riderIds = [
      ...new Set(
        serviceRequests
          .map((sr) => sr.riderId)
          .filter((id): id is string => id !== null),
      ),
    ];
    const riderNames = await this.riderNames(branchIds, riderIds);

    return incidents.map((incident) => {
      const sr = incident.serviceRequestId ? (srById.get(incident.serviceRequestId) ?? null) : null;
      return {
        incident,
        customerName: incident.customerId ? (customerNames.get(incident.customerId) ?? null) : null,
        serviceRequest: sr,
        riderName: sr?.riderId ? (riderNames.get(sr.riderId) ?? null) : null,
      };
    });
  }

  /**
   * Flag an incident as escalated outside the system (story BM-022). Records
   * the flag + timestamp ONLY — no external API calls, no notifications, per the
   * story's explicit "do not overclaim this feature" note. Race-safe: 0 rows
   * affected (already escalated) => 409. 404 if outside the caller's branch.
   */
  async escalateIncident(principal: Principal, id: string): Promise<Incident> {
    const branchIds = this.requireBranches(principal);

    const incident = await this.incidents.findOne({
      where: { id, branchId: In(branchIds) },
    });
    if (!incident) throw new NotFoundException('Incident not found');

    const now = new Date();
    const result = await this.incidents
      .createQueryBuilder()
      .update(Incident)
      .set({ escalated: true, escalatedAt: now, updatedAt: now })
      .where('id = :id AND branch_id IN (:...branchIds) AND escalated = false', {
        id,
        branchIds,
      })
      .execute();
    if (!result.affected) {
      throw new ConflictException('Incident is already escalated');
    }

    incident.escalated = true;
    incident.escalatedAt = now;
    incident.updatedAt = now;
    return incident;
  }

  /**
   * Resolve customer names by id, scoped to the caller's branch(es) and excluding
   * soft-deleted rows. Reads cim.customers by table name rather than importing the
   * CIM module — the same one-way, dependency-free bulk display lookup the LPM
   * service uses (CSAT → CIM only, no module cycle).
   */
  private async customerNames(
    branchIds: string[],
    customerIds: string[],
  ): Promise<Map<string, string>> {
    if (customerIds.length === 0) return new Map();

    const rows = await this.ratings.manager
      .createQueryBuilder()
      .select('c.id', 'id')
      .addSelect('c.name', 'name')
      .from('cim.customers', 'c')
      .where('c.id IN (:...customerIds)', { customerIds })
      .andWhere('c.branch_id IN (:...branchIds)', { branchIds })
      .andWhere('c.deleted_at IS NULL')
      .getRawMany<{ id: string; name: string }>();

    return new Map(rows.map((r) => [r.id, r.name]));
  }

  /** Resolve rider names by id, scoped to the caller's branch(es). */
  private async riderNames(
    branchIds: string[],
    riderIds: string[],
  ): Promise<Map<string, string>> {
    if (riderIds.length === 0) return new Map();

    const riders = await this.riders.find({
      where: { id: In(riderIds), branchId: In(branchIds) },
    });
    return new Map(riders.map((r) => [r.id, r.name]));
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
}
