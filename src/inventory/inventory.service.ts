import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { Principal } from '../auth/principal';
import { LpgProduct } from '../prices/lpg-product.entity';
import { PricesService } from '../prices/prices.service';
import { IntakeStockDto } from './dto/intake-stock.dto';
import { StockLevel } from './stock-level.entity';

/** One row per product the branch could stock — merges the shared LPG
 * catalog (source of truth for which products exist) with the branch's own
 * stock_levels row (source of truth for actual counts, sparse: a product the
 * branch has never received stock for simply has no row yet). */
export interface StockLevelView {
  stockLevelId: string | null;
  branchId: string;
  productId: string;
  productName: string;
  cylinderSize: string;
  currentQty: number;
  thresholdQty: number;
  capacityQty: number;
}

/**
 * Branch Manager Inventory — Stage 1 (stock levels + manual intake) of the
 * real backend behind the previously 100%-mock Inventory screen. Reorder
 * requests are a separate stage, not covered here. Branch scope comes
 * exclusively from the verified principal (AGENTS.md §5).
 */
@Injectable()
export class InventoryService {
  constructor(
    @InjectRepository(StockLevel)
    private readonly stockLevels: Repository<StockLevel>,
    private readonly prices: PricesService,
  ) {}

  async listForBranch(principal: Principal): Promise<StockLevelView[]> {
    const branchIds = this.requireBranches(principal);
    const products = await this.prices.list();
    if (products.length === 0) return [];

    const rows = await this.stockLevels.find({
      where: { branchId: In(branchIds), deletedAt: IsNull() },
    });
    const byKey = new Map(rows.map((row) => [`${row.branchId}:${row.productId}`, row]));

    const views: StockLevelView[] = [];
    for (const branchId of branchIds) {
      for (const product of products) {
        const row = byKey.get(`${branchId}:${product.id}`);
        views.push(this.toView(branchId, product, row ?? null));
      }
    }
    return views;
  }

  /**
   * Manual Stock Intake: atomically adds receivedQty onto the product's
   * current stock for the caller's branch, capped at capacity_qty.
   */
  async intake(principal: Principal, dto: IntakeStockDto): Promise<StockLevelView> {
    const branchId = this.requireBranches(principal)[0];
    const product = await this.findProduct(dto.productId);
    const row = await this.creditStock(branchId, dto.productId, dto.receivedQty, principal.userId);
    return this.toView(branchId, product, row);
  }

  /**
   * Atomically adds qty onto a branch's current stock for a product, capped
   * at capacity_qty. A single INSERT ... ON CONFLICT statement (not
   * read-then-write) so concurrent callers — Manual Stock Intake and a
   * reorder request being marked Delivered — can't race to create duplicate
   * rows or drop an update.
   */
  async creditStock(
    branchId: string,
    productId: string,
    qty: number,
    userId: string,
  ): Promise<StockLevel> {
    const now = new Date();
    await this.stockLevels
      .createQueryBuilder()
      .insert()
      .into(StockLevel)
      .values({
        branchId,
        productId,
        currentQty: qty,
        updatedBy: userId,
        createdAt: now,
        updatedAt: now,
      })
      .onConflict(
        `(branch_id, product_id) WHERE deleted_at IS NULL DO UPDATE SET
          current_qty = LEAST(stock_levels.current_qty + EXCLUDED.current_qty, stock_levels.capacity_qty),
          updated_by = EXCLUDED.updated_by,
          updated_at = EXCLUDED.updated_at`,
      )
      .execute();

    return this.stockLevels.findOneByOrFail({ branchId, productId, deletedAt: IsNull() });
  }

  private async findProduct(productId: string): Promise<LpgProduct> {
    const products = await this.prices.list();
    const product = products.find((p) => p.id === productId);
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  private toView(branchId: string, product: LpgProduct, row: StockLevel | null): StockLevelView {
    return {
      stockLevelId: row?.id ?? null,
      branchId,
      productId: product.id,
      productName: product.name,
      cylinderSize: product.cylinderSize,
      currentQty: row?.currentQty ?? 0,
      thresholdQty: row?.thresholdQty ?? 10,
      capacityQty: row?.capacityQty ?? 100,
    };
  }

  private requireBranches(principal: Principal): string[] {
    if (principal.branchIds.length === 0) {
      throw new ForbiddenException('Caller has no active branch');
    }
    return principal.branchIds;
  }
}
