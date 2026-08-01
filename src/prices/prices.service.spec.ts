import { BadRequestException } from '@nestjs/common';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { NotificationsService } from '../notifications/notifications.service';
import { CYLINDER_SIZES, UpdatePricesDto } from './dto/update-prices.dto';
import { LpgProduct } from './lpg-product.entity';
import { PricesService } from './prices.service';

describe('PricesService', () => {
  const products = CYLINDER_SIZES.map((cylinderSize, index) =>
    Object.assign(new LpgProduct(), {
      id: `product-${index}`,
      name: `${cylinderSize} LPG Cylinder`,
      sku: `LPG-${cylinderSize}`,
      cylinderSizeKg: Number(cylinderSize.replace('kg', '')),
      basePrice: 200 + index * 100,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
  );

  const validUpdate = (): UpdatePricesDto => ({
    prices: CYLINDER_SIZES.map((cylinderSize, index) => ({
      cylinderSize,
      unitPrice: 250 + index * 100,
    })),
  });

  it('updates all shared prices and publishes the staff notification in one transaction', async () => {
    const rootRepository = {
      find: jest.fn(() => Promise.resolve(products)),
    } as unknown as jest.Mocked<Repository<LpgProduct>>;
    const transactionRepository = {
      find: jest.fn(() =>
        Promise.resolve(products.map((product) => Object.assign(new LpgProduct(), product))),
      ),
      save: jest.fn((rows: LpgProduct[]) => Promise.resolve(rows)),
    } as unknown as jest.Mocked<Repository<LpgProduct>>;
    const manager = {
      getRepository: jest.fn(() => transactionRepository),
    } as unknown as EntityManager;
    const dataSource = {
      transaction: jest.fn((work: (value: EntityManager) => Promise<void>) => work(manager)),
    } as unknown as jest.Mocked<DataSource>;
    const notifications = {
      publishPriceUpdate: jest.fn(() => Promise.resolve()),
    } as unknown as jest.Mocked<NotificationsService>;
    const service = new PricesService(rootRepository, dataSource, notifications);

    await service.updateAll(validUpdate());

    expect(transactionRepository.save).toHaveBeenCalledTimes(1);
    expect(transactionRepository.save.mock.calls[0][0]).toHaveLength(CYLINDER_SIZES.length);
    expect(notifications.publishPriceUpdate).toHaveBeenCalledWith(
      expect.stringContaining('50kg'),
      manager,
    );
  });

  it('rejects duplicate or incomplete cylinder submissions before touching the database', async () => {
    const repository = {} as Repository<LpgProduct>;
    const dataSource = { transaction: jest.fn() } as unknown as jest.Mocked<DataSource>;
    const notifications = {} as NotificationsService;
    const service = new PricesService(repository, dataSource, notifications);
    const invalid = validUpdate();
    invalid.prices[4] = { ...invalid.prices[0] };

    await expect(service.updateAll(invalid)).rejects.toBeInstanceOf(BadRequestException);
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });
});
