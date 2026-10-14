import { Controller, Get } from '@nestjs/common';
import { LpgProduct } from './lpg-product.entity';
import { PricesService } from './prices.service';

@Controller('prices')
export class PricesController {
  constructor(private readonly prices: PricesService) {}

  /** Retail prices are public customer-facing data. Changes use Governance requests. */
  @Get()
  async list() {
    return { prices: (await this.prices.list()).map((product) => this.toRow(product)) };
  }

  private toRow(product: LpgProduct) {
    return {
      id: product.id,
      cylinder_size: product.cylinderSize,
      unit_price: product.unitPrice,
      updated_at: product.updatedAt,
    };
  }
}
