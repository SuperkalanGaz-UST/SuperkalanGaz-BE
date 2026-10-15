import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { LpgProduct } from './lpg-product.entity';
import { PricesService } from './prices.service';
import { ListPricesQuery } from './dto/list-prices.query';
import { PHILIPPINE_REGIONS } from './philippine-regions';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentPrincipal } from '../auth/roles.decorator';
import { Principal } from '../auth/principal';

@Controller('prices')
export class PricesController {
  constructor(private readonly prices: PricesService) {}

  /** Retail prices are public customer-facing data. Changes use Governance requests. */
  @Get()
  async list(@Query() query: ListPricesQuery) {
    const catalog = await this.prices.catalog(query.regionCode);
    return {
      prices: catalog.products.map((product) => this.toRow(product)),
      source: catalog.source,
      region_code: query.regionCode ?? null,
    };
  }

  @Get('regions')
  regions() {
    return { regions: PHILIPPINE_REGIONS };
  }

  @Get('assigned')
  @UseGuards(AuthGuard)
  async assigned(@CurrentPrincipal() principal: Principal) {
    const catalog = await this.prices.catalogForBranch(principal);
    return {
      prices: catalog.products.map((product) => this.toRow(product)),
      source: catalog.source,
    };
  }

  @Get('for-branch/:branchId')
  @UseGuards(AuthGuard)
  async forBranch(
    @CurrentPrincipal() principal: Principal,
    @Param('branchId', ParseUUIDPipe) branchId: string,
  ) {
    const catalog = await this.prices.catalogForBranch(principal, branchId);
    return {
      prices: catalog.products.map((product) => this.toRow(product)),
      source: catalog.source,
    };
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
