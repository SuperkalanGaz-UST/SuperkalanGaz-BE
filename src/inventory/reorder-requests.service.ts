import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { Principal } from '../auth/principal';
import { LpgProduct } from '../prices/lpg-product.entity';
import { PricesService } from '../prices/prices.service';
import { CreateReorderRequestDto } from './dto/create-reorder-request.dto';
import { UpdateReorderRequestStatusDto } from './dto/update-reorder-request-status.dto';
import { InventoryService } from './inventory.service';
import { ReorderRequest, ReorderRequestStatus } from './reorder-request.entity';

export interface ReorderRequestView {
  id: string;
  branchId: string;
  productId: string;
  productName: string;
  cylinderSize: string;
  requestedQty: number;
  status: ReorderRequestStatus;
  requestedBy: string;
  requestedByName: string;
  requestedAt: Date;
  decidedAt: Date | null;
}

// Which statuses a request may move to from its current one. Terminal
// statuses (Delivered, Cancelled) have no outgoing edges.
// ponytail: there's no separate approver role/UI in this codebase yet, so
// every transition is self-serve by the requesting branch manager. Add a
// real approval actor when a role for it exists.
const ALLOWED_TRANSITIONS: Record<ReorderRequestStatus, ReorderRequestStatus[]> = {
  Pending: ['Approved', 'Delivered', 'Cancelled'],
  Approved: ['Delivered', 'Cancelled'],
  Delivered: [],
  Cancelled: [],
};

/**
 * Branch Manager Inventory — Stage 2 (reorder requests) of the real backend.
 * Marking a request Delivered credits inventory.stock_levels through the
 * same atomic upsert Manual Stock Intake uses (InventoryService.creditStock),
 * so a delivered reorder doesn't also need a separate manual intake.
 */
@Injectable()
export class ReorderRequestsService {
  constructor(
    @InjectRepository(ReorderRequest)
    private readonly reorderRequests: Repository<ReorderRequest>,
    private readonly prices: PricesService,
    private readonly inventory: InventoryService,
  ) {}

  async listForBranch(principal: Principal): Promise<ReorderRequestView[]> {
    const branchIds = this.requireBranches(principal);
    const [rows, products] = await Promise.all([
      this.reorderRequests.find({
        where: { branchId: In(branchIds), deletedAt: IsNull() },
        order: { requestedAt: 'DESC' },
      }),
      this.prices.list(),
    ]);
    const byId = new Map(products.map((product) => [product.id, product]));
    return rows.map((row) => this.toView(row, byId.get(row.productId)));
  }

  async create(principal: Principal, dto: CreateReorderRequestDto): Promise<ReorderRequestView> {
    const branchId = this.requireBranches(principal)[0];
    const product = await this.findProduct(dto.productId);

    const now = new Date();
    const request = this.reorderRequests.create({
      branchId,
      productId: dto.productId,
      requestedQty: dto.requestedQty,
      status: 'Pending',
      requestedBy: principal.userId,
      requestedByName: principal.displayName ?? principal.username ?? principal.email ?? principal.userId,
      requestedAt: now,
      decidedAt: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
    const saved = await this.reorderRequests.save(request);
    return this.toView(saved, product);
  }

  async updateStatus(
    principal: Principal,
    id: string,
    dto: UpdateReorderRequestStatusDto,
  ): Promise<ReorderRequestView> {
    const branchIds = this.requireBranches(principal);
    const request = await this.reorderRequests.findOne({
      where: { id, branchId: In(branchIds), deletedAt: IsNull() },
    });
    if (!request) throw new NotFoundException('Reorder request not found');

    const allowed = ALLOWED_TRANSITIONS[request.status];
    if (!allowed.includes(dto.status)) {
      throw new BadRequestException(`Cannot move a ${request.status} request to ${dto.status}`);
    }

    if (dto.status === 'Delivered') {
      await this.inventory.creditStock(
        request.branchId,
        request.productId,
        request.requestedQty,
        principal.userId,
      );
    }

    request.status = dto.status;
    request.decidedAt = new Date();
    request.updatedAt = new Date();
    const saved = await this.reorderRequests.save(request);
    return this.toView(saved, await this.findProduct(saved.productId));
  }

  private async findProduct(productId: string): Promise<LpgProduct> {
    const products = await this.prices.list();
    const product = products.find((p) => p.id === productId);
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  private toView(row: ReorderRequest, product: LpgProduct | undefined): ReorderRequestView {
    return {
      id: row.id,
      branchId: row.branchId,
      productId: row.productId,
      // A request can outlive the catalog entry it was made against (product
      // deactivated later) — fall back rather than 500 on a historical row.
      productName: product?.name ?? 'Unknown product',
      cylinderSize: product?.cylinderSize ?? '—',
      requestedQty: row.requestedQty,
      status: row.status,
      requestedBy: row.requestedBy,
      requestedByName: row.requestedByName,
      requestedAt: row.requestedAt,
      decidedAt: row.decidedAt,
    };
  }

  private requireBranches(principal: Principal): string[] {
    if (principal.branchIds.length === 0) {
      throw new ForbiddenException('Caller has no active branch');
    }
    return principal.branchIds;
  }
}
