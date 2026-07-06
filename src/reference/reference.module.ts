import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { KnownStoreLocation } from './known-store-location.entity';
import { ReferenceController } from './reference.controller';
import { ReferenceService } from './reference.service';

/**
 * Reference data module (franchise-global). Provides the read-only known
 * store-location lookup that backs the branch-registration combobox. AuthModule
 * supplies the AuthGuard (and the Profile repository it needs). The Branch
 * entity used in the already_registered join is loaded globally via
 * autoLoadEntities, so it is not re-registered here.
 */
@Module({
  imports: [TypeOrmModule.forFeature([KnownStoreLocation]), AuthModule],
  controllers: [ReferenceController],
  providers: [ReferenceService],
})
export class ReferenceModule {}
