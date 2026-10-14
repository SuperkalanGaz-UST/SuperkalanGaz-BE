import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { Principal } from '../auth/principal';
import { Branch } from '../branches/branch.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { CYLINDER_SIZES, UpdatePricesDto } from './dto/update-prices.dto';
import { LpgProduct } from './lpg-product.entity';
import { PricesService } from './prices.service';
import { RegionalPrice } from './regional-price.entity';

function fixture(region: string | null = 'IV-A') {
  const products = CYLINDER_SIZES.map((size, index) =>
    Object.assign(new LpgProduct(), {
      id: `product-${index}`,
      cylinderSizeKg: Number(size.replace('kg', '')),
      basePrice: 100 + index * 100,
      isActive: true,
    }),
  );
  let overrides: RegionalPrice[] = [];
  const productRepository = {
    find: jest.fn(async () => products),
    findOne: jest.fn(async () => products[2]),
    save: jest.fn(async (rows: LpgProduct[]) => rows),
  };
  const regionalRepository = {
    find: jest.fn(async ({ where }: { where: { regionCode: string } }) =>
      overrides.filter((row) => row.regionCode === where.regionCode),
    ),
    findOne: jest.fn(
      async ({ where }: { where: { regionCode: string; productId: string } }) =>
        overrides.find(
          (row) =>
            row.regionCode === where.regionCode &&
            row.productId === where.productId,
        ) ?? null,
    ),
    create: jest.fn((row: Partial<RegionalPrice>) =>
      Object.assign(new RegionalPrice(), row),
    ),
    save: jest.fn(async (rows: RegionalPrice[]) => {
      overrides = rows;
      return rows;
    }),
  };
  const branchRepository = {
    findOne: jest.fn(async () =>
      Object.assign(new Branch(), { id: 'branch-a', region }),
    ),
    find: jest.fn(async () => [
      Object.assign(new Branch(), { id: 'branch-a' }),
    ]),
  };
  const getRepository = jest.fn((target: unknown) =>
    target === RegionalPrice
      ? regionalRepository
      : target === Branch
        ? branchRepository
        : productRepository,
  );
  const manager = { getRepository } as unknown as EntityManager;
  const dataSource = {
    getRepository,
    transaction: jest.fn(
      async (work: (manager: EntityManager) => Promise<unknown>) =>
        work(manager),
    ),
  } as unknown as DataSource;
  const notifications = {
    publishPriceUpdate: jest.fn(),
    publishRegionalPriceUpdate: jest.fn(),
  };
  const service = new PricesService(
    productRepository as unknown as Repository<LpgProduct>,
    dataSource,
    notifications as unknown as NotificationsService,
  );
  const proposal: UpdatePricesDto = {
    regionCode: 'IV-A',
    prices: products.map((product) => ({
      cylinderSize: product.cylinderSize as (typeof CYLINDER_SIZES)[number],
      unitPrice: product.unitPrice + 20,
    })),
  };
  return {
    service,
    products,
    proposal,
    productRepository,
    regionalRepository,
    branchRepository,
    notifications,
    dataSource,
    manager,
  };
}
const owner = (branchIds: string[]): Principal => ({
  userId: 'owner',
  role: 'branch-owner',
  branches: [],
  branchIds,
});

describe('Regional LPG pricing', () => {
  it('retains system-wide prices for unassigned branches and unconfigured regions', async () => {
    const { service, products, regionalRepository } = fixture(null);
    expect(
      (await service.catalogForBranch(owner(['branch-a']))).products,
    ).toEqual(products);
    expect(regionalRepository.find).not.toHaveBeenCalled();
    expect((await service.catalog('NCR')).source).toBe('system-wide');
    expect(
      (await service.findByCylinderSize('11kg', 'branch-a')).unitPrice,
    ).toBe(300);
  });

  it('rejects an out-of-scope branch before reading its row', async () => {
    const { service, branchRepository } = fixture();
    await expect(
      service.catalogForBranch(owner(['branch-a']), 'branch-b'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(branchRepository.findOne).not.toHaveBeenCalled();
  });

  it('requires explicit branch selection for multi-branch owners', async () => {
    const { service, branchRepository } = fixture();
    await expect(
      service.catalogForBranch(owner(['branch-a', 'branch-b'])),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(branchRepository.findOne).not.toHaveBeenCalled();
  });

  it('updates one region without changing shared prices or other regional lists', async () => {
    const {
      service,
      proposal,
      productRepository,
      regionalRepository,
      branchRepository,
      notifications,
    } = fixture();
    const after = await service.updateAll(proposal);
    expect(after[2].unitPrice).toBe(320);
    expect(regionalRepository.save.mock.calls[0][0]).toHaveLength(5);
    expect(
      regionalRepository.save.mock.calls[0][0].every(
        (row) => row.regionCode === 'IV-A',
      ),
    ).toBe(true);
    expect(productRepository.save).not.toHaveBeenCalled();
    expect((await service.list())[2].unitPrice).toBe(300);
    expect((await service.list('NCR'))[2].unitPrice).toBe(300);
    expect((await service.catalog('IV-A')).source).toBe('regional');
    expect(
      (await service.findByCylinderSize('11kg', 'branch-a')).unitPrice,
    ).toBe(320);
    expect(branchRepository.find).toHaveBeenCalledWith({
      where: { region: 'IV-A', status: 'active' },
      select: { id: true },
    });
    expect(notifications.publishPriceUpdate).not.toHaveBeenCalled();
    expect(notifications.publishRegionalPriceUpdate).toHaveBeenCalledWith(
      expect.stringContaining('IV-A'),
      ['branch-a'],
      expect.anything(),
    );
  });

  it('rejects stale approval baselines without writing or notifying', async () => {
    const { service, proposal, regionalRepository, notifications } = fixture();
    const stale = proposal.prices.map((row) => ({ ...row, unitPrice: 1 }));
    await expect(
      service.updateAll(proposal, undefined, stale),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(regionalRepository.save).not.toHaveBeenCalled();
    expect(notifications.publishRegionalPriceUpdate).not.toHaveBeenCalled();
  });

  it('passes locked before/after prices and the same transaction to the audit writer', async () => {
    const { service, proposal, manager } = fixture();
    const audit = jest.fn(async () => undefined);
    await service.updateAll(proposal, undefined, undefined, audit);
    expect(audit).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ basePrice: 300 })]),
      expect.arrayContaining([expect.objectContaining({ basePrice: 320 })]),
      manager,
    );
  });

  it('fails closed for an invalid assigned region instead of silently charging defaults', async () => {
    const { service } = fixture('unknown');
    await expect(
      service.findByCylinderSize('11kg', 'branch-a'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects fractional-cent prices before starting a transaction', async () => {
    const { service, proposal, dataSource } = fixture();
    proposal.prices[0].unitPrice = 1.234;
    await expect(service.updateAll(proposal)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });
});
