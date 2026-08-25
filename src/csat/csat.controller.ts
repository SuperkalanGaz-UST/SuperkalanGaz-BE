import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { Principal } from '../auth/principal';
import { CurrentPrincipal, Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { CsatService, CsatSummary, IncidentListItem, RatingListItem } from './csat.service';
import { Rating } from './rating.entity';
import { Incident } from './incident.entity';
import { ServiceRequest } from '../service-requests/service-request.entity';
import { ListRatingsQuery } from './dto/list-ratings.query';
import { ResolveRatingDto } from './dto/resolve-rating.dto';
import { CreateIncidentDto } from './dto/create-incident.dto';
import { ListIncidentsQuery } from './dto/list-incidents.query';
import { BranchReportQuery } from '../common/dto/branch-report.query';

/**
 * CSAT Feedback & Analytics — two Branch Manager flows on the same epic:
 * following up on low-rated deliveries (journey BM-US-08), and logging a
 * lost/undelivered cylinder complaint (journey BM-US-04). Both are Branch
 * Manager day-to-day ops (AGENTS.md §7). The Branch Owner report handler is a
 * read-only role override; all follow-up and Incident actions remain BM-only.
 * Scope comes from the verified Principal, never the client.
 *
 * There is deliberately no POST /csat/ratings: ratings are submitted by
 * customers on mobile, not created through the CRM. Incidents ARE created here
 * — logging a complaint is the Branch Manager's own action (BM-019/020/021).
 */
@Controller('csat')
@UseGuards(AuthGuard, RolesGuard)
@Roles('branch-manager')
export class CsatController {
  constructor(private readonly csat: CsatService) {}

  /** Branch Owner read-only CSAT analytics; scope is narrowed server-side. */
  @Get('reports/summary')
  @Roles('branch-owner')
  async branchReport(
    @CurrentPrincipal() principal: Principal,
    @Query() query: BranchReportQuery,
  ) {
    const report = await this.csat.getBranchReport(principal, query);
    return {
      report: {
        average_stars: report.averageStars,
        total_responses: report.totalResponses,
        delivered_requests: report.deliveredRequests,
        response_rate: report.responseRate,
        incidents_raised: report.incidentsRaised,
        rating_distribution: report.ratingDistribution,
      },
    };
  }

  /**
   * The follow-up queue (BM-038): low-CSAT (<= 3 stars by default), Open by
   * default, newest first, for the caller's branch(es). Each row carries the
   * associated Service Request + rider so the BM can review delivery context
   * inline (BM-039). ?maxStars and ?resolution narrow or widen the view.
   */
  @Get('ratings')
  async list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListRatingsQuery,
  ): Promise<{ ratings: ReturnType<CsatController['toRatingListRow']>[] }> {
    const items = await this.csat.listRatings(principal, query);
    return { ratings: items.map((item) => this.toRatingListRow(item)) };
  }

  /**
   * Branch CSAT KPIs (BM-041): the Open Complaints count that decrements on
   * resolve, plus resolved/total/average for the dashboard tiles.
   */
  @Get('summary')
  async summary(
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ summary: ReturnType<CsatController['toSummaryRow']> }> {
    const s = await this.csat.getSummary(principal);
    return { summary: this.toSummaryRow(s) };
  }

  /**
   * Log a resolution note AND mark the rating Resolved (BM-040 + BM-041) — one
   * atomic action, so a complaint is never marked addressed without a note. The
   * note is required (enforced by the DTO → 400 otherwise). Conflicts (409) if it
   * is already resolved; 404 if outside the caller's branch. Returns the
   * resolved row.
   */
  @Post('ratings/:id/resolve')
  async resolve(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveRatingDto,
  ): Promise<{ rating: ReturnType<CsatController['toRatingRow']> }> {
    const row = await this.csat.resolveRating(principal, id, dto);
    return { rating: this.toRatingRow(row) };
  }

  /**
   * Log a complaint against a delivery (BM-019/020/021 combined — journey
   * BM-US-04): validates the linked Service Request is eligible ("closed or
   * active" — Dispatched/En Route/Delivered) and, transactionally, creates the
   * incident and flips the Service Request's status to 'Under Review'. 400 if
   * the SR is not in an eligible state; 404 if outside the caller's branch;
   * 409 if the SR's status changed concurrently before commit. Returns 201.
   */
  @Post('incidents')
  async createIncident(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: CreateIncidentDto,
  ): Promise<{ incident: ReturnType<CsatController['toIncidentRow']> }> {
    const row = await this.csat.createIncident(principal, dto);
    return { incident: this.toIncidentRow(row) };
  }

  /**
   * The Branch Manager's incident queue, defaulting to 'open', newest first, for
   * the caller's branch(es). Each row carries the associated Service Request +
   * rider, the same delivery context BM-039 provides for ratings.
   */
  @Get('incidents')
  async listIncidents(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListIncidentsQuery,
  ): Promise<{ incidents: ReturnType<CsatController['toIncidentListRow']>[] }> {
    const items = await this.csat.listIncidents(principal, query);
    return { incidents: items.map((item) => this.toIncidentListRow(item)) };
  }

  /**
   * Flag an incident as escalated outside the system (BM-022) — records the
   * flag + timestamp only, no external automation. Conflicts (409) if already
   * escalated; 404 if outside the caller's branch. Returns the escalated row.
   */
  @Post('incidents/:id/escalate')
  async escalateIncident(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ incident: ReturnType<CsatController['toIncidentRow']> }> {
    const row = await this.csat.escalateIncident(principal, id);
    return { incident: this.toIncidentRow(row) };
  }

  /** Snake_case rating row, matching the precedent in the SRD/LPM controllers. */
  private toRatingRow(r: Rating) {
    return {
      id: r.id,
      branch_id: r.branchId,
      service_request_id: r.serviceRequestId,
      customer_id: r.customerId,
      stars: r.stars,
      comment: r.comment,
      submitted_at: r.submittedAt,
      resolution_status: r.resolutionStatus,
      resolution_note: r.resolutionNote,
      resolved_by: r.resolvedBy,
      resolved_at: r.resolvedAt,
      created_at: r.createdAt,
    };
  }

  /**
   * The enriched queue row: the rating plus the customer name and the associated
   * delivery's context (BM-039) — the four SLA timestamps, order details, and the
   * rider who delivered it. These are derived in the service, not columns on the
   * rating, so they are appended here.
   */
  private toRatingListRow(item: RatingListItem) {
    const sr = item.serviceRequest;
    return {
      ...this.toRatingRow(item.rating),
      customer_name: item.customerName,
      rider_name: item.riderName,
      service_request: sr ? this.toServiceRequestContext(sr) : null,
    };
  }

  /** The delivery context shown when a BM opens a flagged entry (BM-039). */
  private toServiceRequestContext(sr: ServiceRequest) {
    return {
      id: sr.id,
      order_source: sr.orderSource,
      status: sr.status,
      customer_name: sr.customerName,
      delivery_address: sr.deliveryAddress,
      cylinder_size: sr.cylinderSize,
      quantity: sr.quantity,
      rider_id: sr.riderId,
      // All four SLA timestamps — BM-039's AC calls for them explicitly.
      requested_at: sr.requestedAt,
      dispatched_at: sr.dispatchedAt,
      in_transit_at: sr.inTransitAt,
      delivered_at: sr.deliveredAt,
    };
  }

  /** Snake_case KPI summary. */
  private toSummaryRow(s: CsatSummary) {
    return {
      open_count: s.openCount,
      resolved_count: s.resolvedCount,
      low_csat_open_count: s.lowCsatOpenCount,
      average_stars: s.averageStars,
      total_ratings: s.totalRatings,
    };
  }

  /** Snake_case incident row. */
  private toIncidentRow(i: Incident) {
    return {
      id: i.id,
      branch_id: i.branchId,
      customer_id: i.customerId,
      service_request_id: i.serviceRequestId,
      category: i.category,
      description: i.description,
      status: i.status,
      priority: i.priority,
      reported_at: i.reportedAt,
      first_response_at: i.firstResponseAt,
      resolved_at: i.resolvedAt,
      assigned_to: i.assignedTo,
      resolution_note: i.resolutionNote,
      escalated: i.escalated,
      escalated_at: i.escalatedAt,
      created_at: i.createdAt,
      updated_at: i.updatedAt,
    };
  }

  /**
   * The enriched incident row: the complaint plus the customer name and the
   * associated delivery's context (order details + all four SLA timestamps +
   * rider), the same shape BM-039's rating rows carry.
   */
  private toIncidentListRow(item: IncidentListItem) {
    const sr = item.serviceRequest;
    return {
      ...this.toIncidentRow(item.incident),
      customer_name: item.customerName,
      rider_name: item.riderName,
      service_request: sr ? this.toServiceRequestContext(sr) : null,
    };
  }
}
