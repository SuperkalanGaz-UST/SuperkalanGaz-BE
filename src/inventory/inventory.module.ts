import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { PricesModule } from '../prices/prices.module';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { ReorderRequestsController } from './reorder-requests.controller';
import { ReorderRequestsService } from './reorder-requests.service';
import { ReorderRequest } from './reorder-request.entity';
import { StockLevel } from './stock-level.entity';
import { StockCheckLog } from './stock-check-log.entity';
import { Branch } from '../branches/branch.entity';
import { CatalogItem } from '../loyalty/catalog-item.entity';
import { RewardStockLevel } from './reward-stock-level.entity';
import { RewardInventoryController } from './reward-inventory.controller';
import { RewardInventoryService } from './reward-inventory.service';

@Module({
  imports: [TypeOrmModule.forFeature([StockLevel, ReorderRequest, StockCheckLog, Branch, CatalogItem, RewardStockLevel]), AuthModule, PricesModule],
  controllers: [InventoryController, ReorderRequestsController, RewardInventoryController],
  providers: [InventoryService, ReorderRequestsService, RewardInventoryService],
})
export class InventoryModule {}
