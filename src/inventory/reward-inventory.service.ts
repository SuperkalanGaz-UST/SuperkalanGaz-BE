import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { Principal } from '../auth/principal';
import { Branch } from '../branches/branch.entity';
import { CatalogItem } from '../loyalty/catalog-item.entity';
import { IntakeRewardStockDto } from './dto/intake-reward-stock.dto';
import { RewardStockLevel } from './reward-stock-level.entity';
import { StockCheckLog } from './stock-check-log.entity';

export interface RewardStockRow {
  branch_id: string;
  catalog_item_id: string;
  item_name: string;
  description: string | null;
  category: 'rewards';
  points_cost: number;
  current_qty: number;
  threshold_qty: number;
  capacity_qty: number;
}

@Injectable()
export class RewardInventoryService {
  constructor(
    @InjectRepository(CatalogItem) private readonly catalog: Repository<CatalogItem>,
    @InjectRepository(RewardStockLevel) private readonly targets: Repository<RewardStockLevel>,
    @InjectRepository(Branch) private readonly branches: Repository<Branch>,
  ) {}

  async listForManager(principal: Principal, selected?: string): Promise<RewardStockRow[]> {
    return this.listScoped(this.managerBranch(principal, selected));
  }

  async listForOwner(principal: Principal, branchId: string): Promise<RewardStockRow[]> {
    if (principal.role !== 'branch-owner') throw new ForbiddenException('Only Branch Owners can access this view');
    if (!branchId) throw new BadRequestException('Select a branch to load its inventory');
    if (!principal.branchIds.includes(branchId)) throw new ForbiddenException('Branch is outside your authorized scope');
    const branch = await this.branches.findOne({
      where: { id: branchId, ownerId: principal.userId, status: 'active' }, select: { id: true },
    });
    if (!branch) throw new ForbiddenException('Branch is outside your authorized scope');
    return this.listScoped(branchId);
  }

  async intake(principal: Principal, dto: IntakeRewardStockDto): Promise<RewardStockRow> {
    const branchId = this.managerBranch(principal, dto.branchId);
    // Resolve targets before the write so a missing migration cannot commit an
    // intake and then return an error that encourages the user to submit it twice.
    const target = await this.targets.findOne({
      where: { branchId, catalogItemId: dto.catalogItemId, deletedAt: IsNull() },
    });
    // The same catalog row is locked by redemption UPDATEs. Serializing this read
    // and increment prevents intake from overwriting a concurrent redemption.
    const item = await this.catalog.manager.transaction(async (manager) => {
      const catalog = manager.getRepository(CatalogItem);
      const item = await catalog.findOne({
        where: { id: dto.catalogItemId, branchId, isActive: true },
        lock: { mode: 'pessimistic_write' },
      });
      if (!item) throw new NotFoundException('Reward item not found in this branch');
      if (!Number.isInteger(dto.receivedQty) || dto.receivedQty < 1 || item.stockQty + dto.receivedQty > 2147483647) {
        throw new BadRequestException('Received quantity must be a positive integer within the stock limit');
      }
      item.stockQty += dto.receivedQty;
      item.updatedAt = new Date();
      const saved = await catalog.save(item);
      await manager.insert(StockCheckLog, { branchId, checkedBy: principal.userId, checkedAt: item.updatedAt });
      return saved;
    });
    return this.toRow(item, target);
  }

  private async listScoped(branchId: string): Promise<RewardStockRow[]> {
    const [items, targets] = await Promise.all([
      this.catalog.find({ where: { branchId, isActive: true }, order: { pointsCost: 'ASC', name: 'ASC' } }),
      this.targets.find({ where: { branchId, deletedAt: IsNull() } }),
    ]);
    const byItem = new Map(targets.map((target) => [target.catalogItemId, target]));
    return items.map((item) => this.toRow(item, byItem.get(item.id)));
  }

  private managerBranch(principal: Principal, selected?: string): string {
    // Preserve the existing single-branch Manager contract rather than silently
    // changing auth and every operational flow to support multiple branches.
    if (principal.role !== 'branch-manager' || principal.branchIds.length !== 1) {
      throw new ForbiddenException('Branch Manager must have exactly one active branch');
    }
    const branchId = principal.branchIds[0];
    if (selected && selected !== branchId) throw new ForbiddenException('Branch is outside your authorized scope');
    return branchId;
  }

  private toRow(item: CatalogItem, target?: RewardStockLevel | null): RewardStockRow {
    return {
      branch_id: item.branchId, catalog_item_id: item.id, item_name: item.name,
      description: item.description, category: 'rewards', points_cost: item.pointsCost,
      current_qty: item.stockQty, threshold_qty: target?.thresholdQty ?? 10,
      // Capacity is a display target, not a reason to discard received units.
      capacity_qty: target?.capacityQty ?? 100,
    };
  }
}
