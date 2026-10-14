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

@Module({
  imports: [TypeOrmModule.forFeature([StockLevel, ReorderRequest, StockCheckLog]), AuthModule, PricesModule],
  controllers: [InventoryController, ReorderRequestsController],
  providers: [InventoryService, ReorderRequestsService],
})
export class InventoryModule {}
