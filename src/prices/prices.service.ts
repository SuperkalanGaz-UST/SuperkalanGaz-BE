import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { NotificationsService } from '../notifications/notifications.service';
import { CYLINDER_SIZES, UpdatePricesDto } from './dto/update-prices.dto';
import { LpgProduct } from './lpg-product.entity';

@Injectable()
export class PricesService {
  constructor(
    @InjectRepository(LpgProduct)
    private readonly products: Repository<LpgProduct>,
    private readonly dataSource: DataSource,
    private readonly notifications: NotificationsService,
  ) {}

  async list(): Promise<LpgProduct[]> {
    return this.products.find({
      where: { isActive: true },
      order: { cylinderSizeKg: 'DESC' },
    });
  }

  async findByCylinderSize(cylinderSize: string): Promise<LpgProduct> {
    const cylinderSizeKg = Number(cylinderSize.replace(/kg$/i, ''));
    const product = await this.products.findOne({
      where: { cylinderSizeKg, isActive: true },
    });
    if (!product) throw new NotFoundException('Cylinder size is not available');
    return product;
  }

  async updateAll(
    dto: UpdatePricesDto,
    manager?: EntityManager,
  ): Promise<LpgProduct[]> {
    const submittedSizes = new Set(dto.prices.map((price) => price.cylinderSize));
    if (
      submittedSizes.size !== CYLINDER_SIZES.length ||
      CYLINDER_SIZES.some((size) => !submittedSizes.has(size))
    ) {
      throw new BadRequestException('Submit one price for every supported cylinder size');
    }

    const apply = async (transactionManager: EntityManager) => {
      const repository = transactionManager.getRepository(LpgProduct);
      const current = await repository.find({
        where: { isActive: true },
        lock: { mode: 'pessimistic_write' },
      });
      const currentBySize = new Map(current.map((product) => [product.cylinderSize, product]));
      const now = new Date();
      const changes: string[] = [];
      const changedProducts: LpgProduct[] = [];

      for (const input of dto.prices) {
        const product = currentBySize.get(input.cylinderSize);
        if (!product) throw new NotFoundException(`${input.cylinderSize} is not available`);
        if (product.unitPrice !== input.unitPrice) {
          changes.push(
            `${input.cylinderSize}: ₱${product.unitPrice.toFixed(2)} → ₱${input.unitPrice.toFixed(2)}`,
          );
          product.unitPrice = input.unitPrice;
          product.updatedAt = now;
          changedProducts.push(product);
        }
      }

      if (changes.length > 0) {
        await repository.save(changedProducts);
        await this.notifications.publishPriceUpdate(changes.join('; '), transactionManager);
      }
    };

    if (manager) await apply(manager);
    else await this.dataSource.transaction(apply);

    return this.list();
  }
}
