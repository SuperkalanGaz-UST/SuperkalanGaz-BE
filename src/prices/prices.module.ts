import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { LpgProduct } from './lpg-product.entity';
import { PricesController } from './prices.controller';
import { PricesService } from './prices.service';

@Module({
  imports: [TypeOrmModule.forFeature([LpgProduct]), AuthModule, NotificationsModule],
  controllers: [PricesController],
  providers: [PricesService],
  exports: [PricesService],
})
export class PricesModule {}
