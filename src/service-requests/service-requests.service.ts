import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { Principal } from '../auth/principal';
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
  ) {}

  /**
   * Walk-in / phone intake. The server owns branch_id (the caller's own
   * branch), order_source ('Walk-in/Phone', story BM-027) and status
   * ('Pending') — the client only supplies the customer/order details.
   */
  async create(
    principal: Principal,
    dto: CreateServiceRequestDto,
  ): Promise<ServiceRequest> {
    const branchId = this.requireBranch(principal);

    const now = new Date();
    const serviceRequest = this.serviceRequests.create({
      branchId,
      orderSource: 'Walk-in/Phone',
      status: 'Pending',
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
