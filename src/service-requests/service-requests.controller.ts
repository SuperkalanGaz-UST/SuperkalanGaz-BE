import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { Principal } from '../auth/principal';
import { CurrentPrincipal, Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { CreateServiceRequestDto } from './dto/create-service-request.dto';
import { DispatchServiceRequestDto } from './dto/dispatch-service-request.dto';
import { EditServiceRequestDto } from './dto/edit-service-request.dto';
import { CancelServiceRequestDto } from './dto/cancel-service-request.dto';
import { ReassignServiceRequestDto } from './dto/reassign-service-request.dto';
import { LogDelayReasonDto } from './dto/log-delay-reason.dto';
import { ServiceRequest } from './service-request.entity';
import { ServiceRequestsService } from './service-requests.service';

/**
 * Service Request intake & queue (SRD module). Creating and processing daily
 * orders is Branch Manager day-to-day ops (AGENTS.md §7); FA has no operational
 * writes and BO does not process orders, so only BM reaches these handlers.
 * Scope comes from the verified Principal, never the client.
 */
@Controller('service-requests')
@UseGuards(AuthGuard, RolesGuard)
@Roles('branch-manager')
export class ServiceRequestsController {
  constructor(private readonly serviceRequests: ServiceRequestsService) {}

  @Get()
  async list(
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ serviceRequests: ReturnType<ServiceRequestsController['toListRow']>[] }> {
    const items = await this.serviceRequests.listWithSlaRisk(principal);
    return { serviceRequests: items.map((item) => this.toListRow(item)) };
  }

  @Get(':id')
  async detail(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ serviceRequest: ReturnType<ServiceRequestsController['toRow']> }> {
    const row = await this.serviceRequests.findById(principal, id);
    return { serviceRequest: this.toRow(row) };
  }

  @Post()
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: CreateServiceRequestDto,
  ): Promise<{ serviceRequest: ReturnType<ServiceRequestsController['toRow']> }> {
    const row = await this.serviceRequests.create(principal, dto);
    return { serviceRequest: this.toRow(row) };
  }

  /**
   * Assign an Available rider to a Pending request (manual dispatch, story
   * BM-004). Conflicts if the request is already dispatched (409) and rejects a
   * rider that is not live/Available/in-branch (400) — see the service for the
   * race guard. The updated row (now with rider_id, dispatched_at, status=
   * 'Dispatched') is returned in the standard envelope.
   */
  @Post(':id/dispatch')
  async dispatch(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DispatchServiceRequestDto,
  ): Promise<{ serviceRequest: ReturnType<ServiceRequestsController['toRow']> }> {
    const row = await this.serviceRequests.dispatch(principal, id, dto);
    return { serviceRequest: this.toRow(row) };
  }

  /**
   * Mark an out-for-delivery request delivered (story BM-007). Closes the SLA
   * chain (delivered_at + status='Delivered') and returns the assigned rider to
   * the Available roster. No request body. Conflicts if the request is not out
   * for delivery — still Pending, already Delivered, or Cancelled (409) — see the
   * service for the race guard. The updated row (status='Delivered', delivered_at
   * set) is returned in the standard envelope.
   */
  @Post(':id/deliver')
  async deliver(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ serviceRequest: ReturnType<ServiceRequestsController['toRow']> }> {
    const row = await this.serviceRequests.deliver(principal, id);
    return { serviceRequest: this.toRow(row) };
  }

  /**
   * Edit a pre-dispatch request (stories BM-034/035/037). Body is a partial set
   * of mutable order details — at least one field, enforced by the DTO (empty
   * body → 400). Conflicts if the request is no longer editable, i.e. already
   * dispatched, cancelled, or deleted (409); 404 if outside the caller's branch.
   * The updated row is returned in the standard envelope.
   */
  @Patch(':id')
  async edit(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EditServiceRequestDto,
  ): Promise<{ serviceRequest: ReturnType<ServiceRequestsController['toRow']> }> {
    const row = await this.serviceRequests.edit(principal, id, dto);
    return { serviceRequest: this.toRow(row) };
  }

  /**
   * Cancel a pre-dispatch request (story BM-036). Requires a non-empty reason
   * (enforced by the DTO → 400 otherwise), which is recorded to the audit trail.
   * Voids the SLA clock without setting any SLA timestamp. Conflicts if the
   * request is already dispatched, cancelled, or deleted (409); 404 if outside
   * the caller's branch. The updated row (status='Cancelled') is returned.
   */
  @Post(':id/cancel')
  async cancel(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelServiceRequestDto,
  ): Promise<{ serviceRequest: ReturnType<ServiceRequestsController['toRow']> }> {
    const row = await this.serviceRequests.cancel(principal, id, dto);
    return { serviceRequest: this.toRow(row) };
  }

  /**
   * Replace the assigned rider on a delayed, out-for-delivery request (story
   * BM-010). Body is just the new rider. 400 if the request is not out for
   * delivery, the new rider isn't assignable, or it's the same rider already
   * assigned; 409 if the request's rider assignment changed concurrently
   * (race); 404 if outside the caller's branch. The updated row is returned.
   */
  @Post(':id/reassign')
  async reassign(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReassignServiceRequestDto,
  ): Promise<{ serviceRequest: ReturnType<ServiceRequestsController['toRow']> }> {
    const row = await this.serviceRequests.reassign(principal, id, dto);
    return { serviceRequest: this.toRow(row) };
  }

  /**
   * Log a delay reason (story BM-011): a dropdown category plus an optional
   * free-text note, combined into the row's delay_reason. Available on any
   * still-in-flight request (Pending/Dispatched/En Route) — 400 otherwise;
   * 404 if outside the caller's branch. The updated row is returned.
   */
  @Post(':id/delay-reason')
  async logDelayReason(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LogDelayReasonDto,
  ): Promise<{ serviceRequest: ReturnType<ServiceRequestsController['toRow']> }> {
    const row = await this.serviceRequests.logDelayReason(principal, id, dto);
    return { serviceRequest: this.toRow(row) };
  }

  /** Snake_case response row, matching the precedent in UsersController.toRow. */
  private toRow(sr: ServiceRequest) {
    return {
      id: sr.id,
      branch_id: sr.branchId,
      order_source: sr.orderSource,
      status: sr.status,
      customer_id: sr.customerId,
      customer_name: sr.customerName,
      customer_contact: sr.customerContact,
      delivery_address: sr.deliveryAddress,
      cylinder_size: sr.cylinderSize,
      quantity: sr.quantity,
      unit_price: sr.unitPrice,
      total_amount: sr.totalAmount,
      special_instructions: sr.specialInstructions,
      rider_id: sr.riderId,
      requested_at: sr.requestedAt,
      dispatched_at: sr.dispatchedAt,
      in_transit_at: sr.inTransitAt,
      delivered_at: sr.deliveredAt,
      delay_reason: sr.delayReason,
      sla_breached: sr.slaBreached,
      sla_breach_segment: sr.slaBreachSegment,
      sla_breached_at: sr.slaBreachedAt,
      created_at: sr.createdAt,
    };
  }

  /**
   * The queue row (BM-008): the base row plus the LIVE "at risk" flag (not a
   * column — see ServiceRequestsService.listWithSlaRisk). sla_breached (a real
   * column) is the separate PERSISTED record from delivery time (BM-012); a
   * row can have sla_at_risk=false and sla_breached=true simultaneously (an
   * already-delivered request that breached, now closed and no longer "at
   * risk" since there is nothing left to act on).
   */
  private toListRow(item: {
    serviceRequest: ServiceRequest;
    slaAtRisk: boolean;
    slaAtRiskSegment: string | null;
  }) {
    return {
      ...this.toRow(item.serviceRequest),
      sla_at_risk: item.slaAtRisk,
      sla_at_risk_segment: item.slaAtRiskSegment,
    };
  }
}
