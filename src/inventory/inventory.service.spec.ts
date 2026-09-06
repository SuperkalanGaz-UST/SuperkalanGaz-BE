import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { Principal } from '../auth/principal';
import { LpgProduct } from '../prices/lpg-product.entity';
import { PricesService } from '../prices/prices.service';
import { InventoryService } from './inventory.service';
import { StockLevel } from './stock-level.entity';

describe('InventoryService', () => {
  const product = (overrides: Partial<LpgProduct> = {}): LpgProduct =>
    ({
      id: 'product-11kg',
      name: '11kg LPG Cylinder',
      cylinderSizeKg: 11,
      cylinderSize: '11kg',
      isActive: true,
      ...overrides,
    }) as LpgProduct;

  const makeRepo = (opts?: { found?: StockLevel[]; findOneResult?: StockLevel }) => {
    const insertQb = {
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      onConflict: jest.fn().mockReturnThis(),
      execute: jest.fn(() => Promise.resolve({})),
    };
    const repo = {
      find: jest.fn(() => Promise.resolve(opts?.found ?? [])),
      findOneByOrFail: jest.fn(() =>
        Promise.resolve(
          opts?.findOneResult ??
            ({
              id: 'stock-1',
              branchId: 'branch-1',
              productId: 'product-11kg',
              currentQty: 15,
              thresholdQty: 10,
              capacityQty: 100,
            } as StockLevel),
        ),
      ),
      createQueryBuilder: jest.fn(() => ({ insert: jest.fn(() => insertQb) })),
    } as unknown as jest.Mocked<Repository<StockLevel>>;
    return { repo, insertQb };
  };

  const makePrices = (products: LpgProduct[]) =>
    ({ list: jest.fn(() => Promise.resolve(products)) }) as unknown as PricesService;

  const principal = (branchIds: string[] = ['branch-1']): Principal => ({
    userId: 'manager-1',
    role: 'branch-manager',
    branches: ['Quezon City Branch'],
    branchIds,
  });

  describe('listForBranch', () => {
    it('defaults a product with no stock_levels row to zero stock and server defaults', async () => {
      const { repo } = makeRepo({ found: [] });
      const service = new InventoryService(repo, makePrices([product()]));

      const views = await service.listForBranch(principal());

      expect(views).toEqual([
        {
          stockLevelId: null,
          branchId: 'branch-1',
          productId: 'product-11kg',
          productName: '11kg LPG Cylinder',
          cylinderSize: '11kg',
          currentQty: 0,
          thresholdQty: 10,
          capacityQty: 100,
        },
      ]);
    });

    it('merges in the branch\'s real stock_levels row when one exists', async () => {
      const existing = {
        id: 'stock-1',
        branchId: 'branch-1',
        productId: 'product-11kg',
        currentQty: 42,
        thresholdQty: 8,
        capacityQty: 60,
      } as StockLevel;
      const { repo } = makeRepo({ found: [existing] });
      const service = new InventoryService(repo, makePrices([product()]));

      const [view] = await service.listForBranch(principal());

      expect(view.stockLevelId).toBe('stock-1');
      expect(view.currentQty).toBe(42);
      expect(view.thresholdQty).toBe(8);
      expect(view.capacityQty).toBe(60);
    });

    it('rejects a principal with no active branch', async () => {
      const { repo } = makeRepo();
      const service = new InventoryService(repo, makePrices([product()]));

      await expect(service.listForBranch(principal([]))).rejects.toThrow(ForbiddenException);
    });
  });

  describe('intake', () => {
    it('inserts with an ON CONFLICT increment and returns the merged view', async () => {
      const { repo, insertQb } = makeRepo();
      const service = new InventoryService(repo, makePrices([product()]));

      const view = await service.intake(principal(), { productId: 'product-11kg', receivedQty: 20 });

      expect(insertQb.values).toHaveBeenCalledWith(
        expect.objectContaining({ branchId: 'branch-1', productId: 'product-11kg', currentQty: 20 }),
      );
      // The conflict clause increments the EXISTING row and caps at its own
      // capacity_qty — this is a DB-level atomic upsert, not read-then-write.
      expect(insertQb.onConflict).toHaveBeenCalledWith(expect.stringContaining('LEAST('));
      expect(view.currentQty).toBe(15); // from the mocked post-upsert re-fetch
    });

    it('uses the caller\'s first branch when the principal has more than one', async () => {
      const { repo, insertQb } = makeRepo();
      const service = new InventoryService(repo, makePrices([product()]));

      await service.intake(principal(['branch-1', 'branch-2']), {
        productId: 'product-11kg',
        receivedQty: 5,
      });

      expect(insertQb.values).toHaveBeenCalledWith(
        expect.objectContaining({ branchId: 'branch-1' }),
      );
    });

    it('404s on a product id the shared catalog does not recognize', async () => {
      const { repo } = makeRepo();
      const service = new InventoryService(repo, makePrices([product()]));

      await expect(
        service.intake(principal(), { productId: 'unknown-product', receivedQty: 5 }),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
