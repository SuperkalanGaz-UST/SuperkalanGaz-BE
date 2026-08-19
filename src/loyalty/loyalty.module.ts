import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { CimModule } from '../cim/cim.module';
import { Branch } from '../branches/branch.entity';
import { CatalogItem } from './catalog-item.entity';
import { CommercialLoyaltyAccount } from './commercial-loyalty-account.entity';
import { CommercialPurchaseRecord } from './commercial-purchase-record.entity';
import { HouseholdLoyaltyAccount } from './household-loyalty-account.entity';
import { HouseholdPointTransaction } from './household-point-transaction.entity';
import { Redemption } from './redemption.entity';
import { LoyaltyController } from './loyalty.controller';
import { LoyaltyService } from './loyalty.service';

/**
 * LPM module — household loyalty redemption (BM-US-03, household track only,
 * AGENTS.md §8a). CimModule exports CimService, reused here to validate the
 * customer link when a redemption request is filed — mirroring how the SRD module
 * reuses CimService/FleetService. The dependency runs LPM → CIM only (CIM never
 * imports LPM), so there is no module cycle; the bulk customer-name lookup in the
 * list reads cim.customers by table name for the same reason.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Redemption,
      CatalogItem,
      HouseholdLoyaltyAccount,
      HouseholdPointTransaction,
      CommercialLoyaltyAccount,
      CommercialPurchaseRecord,
      Branch,
    ]),
    AuthModule,
    CimModule,
  ],
  controllers: [LoyaltyController],
  providers: [LoyaltyService],
  exports: [LoyaltyService],
})
export class LoyaltyModule {}
