import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { UpdatePricesDto } from './dto/update-prices.dto';
import { LpgProduct } from './lpg-product.entity';
import { PricesService } from './prices.service';

@Controller('prices')
export class PricesController {
  constructor(private readonly prices: PricesService) {}

  /** Retail prices are public customer-facing data; writes remain FA-only. */
  @Get()
  async list() {
    return { prices: (await this.prices.list()).map((product) => this.toRow(product)) };
  }

  @Patch()
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('franchise-admin')
  async update(@Body() dto: UpdatePricesDto) {
    return { prices: (await this.prices.updateAll(dto)).map((product) => this.toRow(product)) };
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
