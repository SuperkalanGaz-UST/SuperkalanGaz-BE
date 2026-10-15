import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { NotificationsService } from '../notifications/notifications.service';
import { CYLINDER_SIZES, UpdatePricesDto } from './dto/update-prices.dto';
import { LpgProduct } from './lpg-product.entity';
import { Branch } from '../branches/branch.entity';
import { Principal } from '../auth/principal';
import { isRegionCode, RegionCode } from './philippine-regions';
import { RegionalPrice } from './regional-price.entity';

@Injectable()
export class PricesService {
  constructor(
    @InjectRepository(LpgProduct)
    private readonly products: Repository<LpgProduct>,
    private readonly dataSource: DataSource,
    private readonly notifications: NotificationsService,
  ) {}

  async list(regionCode?: RegionCode): Promise<LpgProduct[]> {
    const products = await this.products.find({
      where: { isActive: true },
      order: { cylinderSizeKg: 'DESC' },
    });
    if (!regionCode) return products;
    const overrides = await this.dataSource
      .getRepository(RegionalPrice)
      .find({ where: { regionCode } });
    return this.withRegionalPrices(products, overrides);
  }

  async catalog(regionCode?: RegionCode) {
    if (!regionCode)
      return { products: await this.list(), source: 'system-wide' as const };
    const products = await this.products.find({
      where: { isActive: true },
      order: { cylinderSizeKg: 'DESC' },
    });
    const overrides = await this.dataSource
      .getRepository(RegionalPrice)
      .find({ where: { regionCode } });
    return {
      products: this.withRegionalPrices(products, overrides),
      source: overrides.length
        ? ('regional' as const)
        : ('system-wide' as const),
    };
  }

  private withRegionalPrices(
    products: LpgProduct[],
    overrides: RegionalPrice[],
  ): LpgProduct[] {
    const byProduct = new Map(overrides.map((row) => [row.productId, row]));
    return products.map((product) => {
      const override = byProduct.get(product.id);
      return override
        ? Object.assign(new LpgProduct(), product, {
            basePrice: override.unitPrice,
            updatedAt: override.updatedAt,
          })
        : product;
    });
  }

  async regionForBranch(branchId: string): Promise<RegionCode | undefined> {
    const branch = await this.dataSource.getRepository(Branch).findOne({
      where: { id: branchId, status: 'active' },
      select: { id: true, region: true },
    });
    if (!branch) throw new NotFoundException('Branch not found');
    if (branch.region !== null && !isRegionCode(branch.region)) {
      throw new ConflictException(
        'Assign a valid pricing region to this branch',
      );
    }
    return branch.region ?? undefined;
  }

  async catalogForBranch(principal: Principal, branchId?: string) {
    const scoped =
      principal.role === 'branch-owner' ||
      principal.role === 'branch-manager' ||
      principal.role === 'driver';
    const selected =
      branchId ??
      (principal.branchIds.length === 1 ? principal.branchIds[0] : undefined);
    if (!selected)
      throw new BadRequestException('Select a branch to load its prices');
    if (scoped && !principal.branchIds.includes(selected))
      throw new ForbiddenException('Branch is outside your authorized scope');
    if (
      !scoped &&
      !['franchise-admin', 'super-admin', 'customer'].includes(principal.role)
    )
      throw new ForbiddenException('Prices are unavailable for this role');
    // Customers may choose an active branch for retail pricing, just as in order placement.
    return this.catalog(await this.regionForBranch(selected));
  }

  async findByCylinderSize(
    cylinderSize: string,
    branchId?: string,
  ): Promise<LpgProduct> {
    const cylinderSizeKg = Number(cylinderSize.replace(/kg$/i, ''));
    const product = await this.products.findOne({
      where: { cylinderSizeKg, isActive: true },
    });
    if (!product) throw new NotFoundException('Cylinder size is not available');
    if (branchId) {
      const regionCode = await this.regionForBranch(branchId);
      if (regionCode) {
        const override = await this.dataSource
          .getRepository(RegionalPrice)
          .findOne({ where: { regionCode, productId: product.id } });
        if (override)
          return Object.assign(new LpgProduct(), product, {
            basePrice: override.unitPrice,
            updatedAt: override.updatedAt,
          });
      }
    }
    return product;
  }

  async updateAll(
    dto: UpdatePricesDto,
    manager?: EntityManager,
    expectedPrices?: UpdatePricesDto['prices'],
    onApplied?: (
      before: LpgProduct[],
      after: LpgProduct[],
      manager: EntityManager,
    ) => Promise<void>,
  ): Promise<LpgProduct[]> {
    const submittedSizes = new Set(
      dto.prices.map((price) => price.cylinderSize),
    );
    if (dto.regionCode !== undefined && !isRegionCode(dto.regionCode))
      throw new BadRequestException('Invalid pricing region');
    if (
      dto.prices.some(
        (price) =>
          !Number.isFinite(price.unitPrice) ||
          price.unitPrice < 0.01 ||
          price.unitPrice > 99999999.99 ||
          Math.abs(price.unitPrice * 100 - Math.round(price.unitPrice * 100)) >
            0.000001,
      )
    ) {
      throw new BadRequestException(
        'Prices must be positive amounts with at most two decimal places',
      );
    }
    if (
      submittedSizes.size !== CYLINDER_SIZES.length ||
      CYLINDER_SIZES.some((size) => !submittedSizes.has(size))
    ) {
      throw new BadRequestException(
        'Submit one price for every supported cylinder size',
      );
    }

    const apply = async (transactionManager: EntityManager) => {
      const repository = transactionManager.getRepository(LpgProduct);
      const current = await repository.find({
        where: { isActive: true },
        lock: { mode: 'pessimistic_write' },
      });
      const currentBySize = new Map(
        current.map((product) => [product.cylinderSize, product]),
      );
      const regionalRepository = dto.regionCode
        ? transactionManager.getRepository(RegionalPrice)
        : null;
      const regionalRows = regionalRepository
        ? await regionalRepository.find({
            where: { regionCode: dto.regionCode },
            lock: { mode: 'pessimistic_write' },
          })
        : [];
      const effective = this.withRegionalPrices(current, regionalRows).map(
        (product) => Object.assign(new LpgProduct(), product),
      );
      if (
        expectedPrices &&
        expectedPrices.some(
          (expected) =>
            effective.find(
              (product) => product.cylinderSize === expected.cylinderSize,
            )?.unitPrice !== expected.unitPrice,
        )
      ) {
        throw new ConflictException(
          'Approved prices have changed since this proposal was submitted. Submit a new proposal.',
        );
      }
      const now = new Date();
      const changes: string[] = [];
      const changedProducts: LpgProduct[] = [];
      const regionalUpdates: RegionalPrice[] = [];

      for (const input of dto.prices) {
        const product = currentBySize.get(input.cylinderSize);
        if (!product)
          throw new NotFoundException(`${input.cylinderSize} is not available`);
        const currentPrice = effective.find(
          (row) => row.id === product.id,
        )!.unitPrice;
        if (currentPrice !== input.unitPrice) {
          changes.push(
            `${input.cylinderSize}: ₱${currentPrice.toFixed(2)} → ₱${input.unitPrice.toFixed(2)}`,
          );
        }
        if (regionalRepository && dto.regionCode) {
          const row =
            regionalRows.find((price) => price.productId === product.id) ??
            regionalRepository.create({
              regionCode: dto.regionCode,
              productId: product.id,
              createdAt: now,
            });
          row.unitPrice = input.unitPrice;
          row.updatedAt = now;
          regionalUpdates.push(row);
        } else if (currentPrice !== input.unitPrice) {
          product.unitPrice = input.unitPrice;
          product.updatedAt = now;
          changedProducts.push(product);
        }
      }

      if (changes.length > 0) {
        if (regionalRepository) {
          await regionalRepository.save(regionalUpdates);
          const branches = await transactionManager.getRepository(Branch).find({
            where: { region: dto.regionCode, status: 'active' },
            select: { id: true },
          });
          await this.notifications.publishRegionalPriceUpdate(
            `${dto.regionCode}: ${changes.join('; ')}`,
            branches.map((branch) => branch.id),
            transactionManager,
          );
        } else {
          await repository.save(changedProducts);
          await this.notifications.publishPriceUpdate(
            changes.join('; '),
            transactionManager,
          );
        }
      }
      const after = dto.regionCode
        ? this.withRegionalPrices(
            current,
            changes.length > 0 ? regionalUpdates : regionalRows,
          )
        : current;
      if (onApplied) await onApplied(effective, after, transactionManager);
      return after.sort((a, b) => b.cylinderSizeKg - a.cylinderSizeKg);
    };

    // Return transaction-local rows so callers never read uncommitted writes through another connection.
    return manager ? apply(manager) : this.dataSource.transaction(apply);
  }
}
