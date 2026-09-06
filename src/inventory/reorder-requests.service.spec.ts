import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { Principal } from '../auth/principal';
import { LpgProduct } from '../prices/lpg-product.entity';
import { PricesService } from '../prices/prices.service';
import { InventoryService } from './inventory.service';
import { ReorderRequest } from './reorder-request.entity';
import { ReorderRequestsService } from './reorder-requests.service';

describe('ReorderRequestsService', () => {
  const product = (overrides: Partial<LpgProduct> = {}): LpgProduct =>
    ({
      id: 'product-11kg',
      name: '11kg LPG Cylinder',
      cylinderSizeKg: 11,
      cylinderSize: '11kg',
      isActive: true,
      ...overrides,
    }) as LpgProduct;

  const makeRepo = (opts?: { found?: ReorderRequest[]; findOneResult?: ReorderRequest | null }) => {
    const repo = {
      find: jest.fn(() => Promise.resolve(opts?.found ?? [])),
      findOne: jest.fn(() => Promise.resolve(opts?.findOneResult ?? null)),
      create: jest.fn((data) => data as ReorderRequest),
      save: jest.fn((data) => Promise.resolve({ id: 'req-1', ...data }) as Promise<ReorderRequest>),
    } as unknown as jest.Mocked<Repository<ReorderRequest>>;
    return repo;
  };

  const makePrices = (products: LpgProduct[]) =>
    ({ list: jest.fn(() => Promise.resolve(products)) }) as unknown as PricesService;

  const makeInventory = () =>
    ({ creditStock: jest.fn(() => Promise.resolve({})) }) as unknown as jest.Mocked<InventoryService>;

  const principal = (overrides: Partial<Principal> = {}): Principal => ({
    userId: 'manager-1',
    role: 'branch-manager',
    displayName: 'Ada Manager',
    branches: ['Amadeo, Cavite'],
    branchIds: ['branch-1'],
    ...overrides,
  });

  describe('create', () => {
    it('creates a Pending request against a known catalog product', async () => {
      const repo = makeRepo();
      const inventory = makeInventory();
      const service = new ReorderRequestsService(repo, makePrices([product()]), inventory);

      const view = await service.create(principal(), { productId: 'product-11kg', requestedQty: 20 });

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          branchId: 'branch-1',
          productId: 'product-11kg',
          requestedQty: 20,
          status: 'Pending',
          requestedBy: 'manager-1',
          requestedByName: 'Ada Manager',
        }),
      );
      expect(view.status).toBe('Pending');
      expect(view.productName).toBe('11kg LPG Cylinder');
    });

    it('404s on a product id the shared catalog does not recognize', async () => {
      const service = new ReorderRequestsService(makeRepo(), makePrices([product()]), makeInventory());

      await expect(
        service.create(principal(), { productId: 'unknown-product', requestedQty: 20 }),
      ).rejects.toThrow(NotFoundException);
    });

    it('rejects a principal with no active branch', async () => {
      const service = new ReorderRequestsService(makeRepo(), makePrices([product()]), makeInventory());

      await expect(
        service.create(principal({ branchIds: [] }), { productId: 'product-11kg', requestedQty: 20 }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('updateStatus', () => {
    const pendingRequest = (): ReorderRequest =>
      ({
        id: 'req-1',
        branchId: 'branch-1',
        productId: 'product-11kg',
        requestedQty: 20,
        status: 'Pending',
        requestedBy: 'manager-1',
        requestedByName: 'Ada Manager',
        requestedAt: new Date(),
        decidedAt: null,
      }) as ReorderRequest;

    it('moves Pending -> Approved without touching stock', async () => {
      const repo = makeRepo({ findOneResult: pendingRequest() });
      const inventory = makeInventory();
      const service = new ReorderRequestsService(repo, makePrices([product()]), inventory);

      const view = await service.updateStatus(principal(), 'req-1', { status: 'Approved' });

      expect(view.status).toBe('Approved');
      expect(inventory.creditStock).not.toHaveBeenCalled();
    });

    it('moves Pending -> Delivered and credits stock with the requested qty', async () => {
      const repo = makeRepo({ findOneResult: pendingRequest() });
      const inventory = makeInventory();
      const service = new ReorderRequestsService(repo, makePrices([product()]), inventory);

      const view = await service.updateStatus(principal(), 'req-1', { status: 'Delivered' });

      expect(inventory.creditStock).toHaveBeenCalledWith('branch-1', 'product-11kg', 20, 'manager-1');
      expect(view.status).toBe('Delivered');
    });

    it('rejects a transition out of a terminal state', async () => {
      const delivered = { ...pendingRequest(), status: 'Delivered' } as ReorderRequest;
      const repo = makeRepo({ findOneResult: delivered });
      const service = new ReorderRequestsService(repo, makePrices([product()]), makeInventory());

      await expect(
        service.updateStatus(principal(), 'req-1', { status: 'Cancelled' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('404s when the request does not exist for the caller\'s branch', async () => {
      const repo = makeRepo({ findOneResult: null });
      const service = new ReorderRequestsService(repo, makePrices([product()]), makeInventory());

      await expect(
        service.updateStatus(principal(), 'missing', { status: 'Approved' }),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
