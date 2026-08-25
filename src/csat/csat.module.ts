import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { Rating } from './rating.entity';
import { Incident } from './incident.entity';
import { ServiceRequest } from '../service-requests/service-request.entity';
import { Rider } from '../fleet/rider.entity';
import { CsatController } from './csat.controller';
import { CsatService } from './csat.service';

/**
 * CSAT module — two Branch Manager flows plus the Branch Owner's read-only CSAT
 * report: closed-loop follow-up on low-rated deliveries (BM-US-08) and logging
 * a lost/undelivered cylinder complaint (BM-US-04). ServiceRequest and Rider
 * are registered so both queues can enrich
 * their rows with delivery context (stories BM-039 / the incident equivalent)
 * without importing the SRD/Fleet modules — read access keeps the dependency
 * one-way and cycle-free (the same approach LPM takes for cim.customers), and
 * incident creation additionally WRITES ServiceRequest.status transactionally.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Rating, Incident, ServiceRequest, Rider]),
    AuthModule,
  ],
  controllers: [CsatController],
  providers: [CsatService],
})
export class CsatModule {}
