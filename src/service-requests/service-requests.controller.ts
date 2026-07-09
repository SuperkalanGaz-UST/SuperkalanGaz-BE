import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { Principal } from '../auth/principal';
import { CurrentPrincipal, Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { CreateServiceRequestDto } from './dto/create-service-request.dto';
import { DispatchServiceRequestDto } from './dto/dispatch-service-request.dto';
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
  ): Promise<{ serviceRequests: ReturnType<ServiceRequestsController['toRow']>[] }> {
    const rows = await this.serviceRequests.list(principal);
    return { serviceRequests: rows.map((r) => this.toRow(r)) };
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

  /** Snake_case response row, matching the precedent in UsersController.toRow. */
  private toRow(sr: ServiceRequest) {
    return {
      id: sr.id,
      branch_id: sr.branchId,
      order_source: sr.orderSource,
      status: sr.status,
      customer_name: sr.customerName,
      customer_contact: sr.customerContact,
      delivery_address: sr.deliveryAddress,
      cylinder_size: sr.cylinderSize,
      quantity: sr.quantity,
      special_instructions: sr.specialInstructions,
      rider_id: sr.riderId,
      requested_at: sr.requestedAt,
      dispatched_at: sr.dispatchedAt,
      in_transit_at: sr.inTransitAt,
      delivered_at: sr.deliveredAt,
      created_at: sr.createdAt,
    };
  }
}
