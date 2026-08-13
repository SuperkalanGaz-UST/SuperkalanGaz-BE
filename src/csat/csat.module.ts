import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { Rating } from './rating.entity';
import { ServiceRequest } from '../service-requests/service-request.entity';
import { Rider } from '../fleet/rider.entity';
import { CsatController } from './csat.controller';
import { CsatService } from './csat.service';

/**
 * CSAT module — the Branch Manager's closed-loop follow-up on low-rated
 * deliveries (journey BM-US-08). ServiceRequest and Rider are registered so the
 * queue can enrich each rating with its delivery context (story BM-039) without
 * importing the SRD/Fleet modules — read-only entity access keeps the dependency
 * one-way and cycle-free, the same approach LPM takes for cim.customers.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Rating, ServiceRequest, Rider]),
    AuthModule,
  ],
  controllers: [CsatController],
  providers: [CsatService],
})
export class CsatModule {}
