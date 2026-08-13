import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThanOrEqual, Repository } from 'typeorm';
import { Principal } from '../auth/principal';
import { Rating } from './rating.entity';
import { ServiceRequest } from '../service-requests/service-request.entity';
import { Rider } from '../fleet/rider.entity';
import { ListRatingsQuery } from './dto/list-ratings.query';
import { ResolveRatingDto } from './dto/resolve-rating.dto';

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

/**
 * CSAT Feedback & Analytics module — the Branch Manager's closed-loop follow-up
 * on low-rated deliveries (journey BM-US-08). Ratings are submitted by CUSTOMERS
 * on mobile (AGENTS.md §7); this service never creates them. It reads them,
 * surfaces the low-CSAT band with delivery context, and records the BM's
 * resolution.
 *
 * All scoping derives from the verified Principal, never from request input
 * (AGENTS.md §5). Isolation is enforced here in the application layer, not by the
 * DB — a missing branch filter is a cross-tenant leak. The resolve transition
 * uses a race-safe conditional UPDATE.
 */
@Injectable()
export class CsatService {
  constructor(
    @InjectRepository(Rating)
    private readonly ratings: Repository<Rating>,
    @InjectRepository(ServiceRequest)
    private readonly serviceRequests: Repository<ServiceRequest>,
    @InjectRepository(Rider)
    private readonly riders: Repository<Rider>,
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

    // Default to the actionable low-CSAT queue; callers may widen deliberately.
    const maxStars = query.maxStars ?? LOW_CSAT_MAX_STARS;
    const resolution = query.resolution ?? 'Open';

    const ratings = await this.ratings.find({
      where: {
        branchId: In(branchIds),
        stars: LessThanOrEqual(maxStars),
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

    const openCount = rows.filter((r) => r.resolutionStatus === 'Open').length;
    const lowCsatOpenCount = rows.filter(
      (r) => r.resolutionStatus === 'Open' && r.stars <= LOW_CSAT_MAX_STARS,
    ).length;

    return {
      openCount,
      resolvedCount: rows.length - openCount,
      lowCsatOpenCount,
      averageStars: rows.length
        ? Number((rows.reduce((sum, r) => sum + r.stars, 0) / rows.length).toFixed(2))
        : null,
      totalRatings: rows.length,
    };
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
}
