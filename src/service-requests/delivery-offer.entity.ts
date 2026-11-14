import { Column, Entity, PrimaryGeneratedColumn, type EntityManager } from 'typeorm';
import { ServiceRequest } from './service-request.entity';

@Entity({ schema: 'srd', name: 'delivery_offers' })
export class DeliveryOffer {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'branch_id', type: 'uuid' })
  branchId!: string;

  @Column({ name: 'service_request_id', type: 'uuid' })
  serviceRequestId!: string;

  @Column({ name: 'rider_id', type: 'uuid' })
  riderId!: string;

  @Column({ name: 'previous_rider_id', type: 'uuid', nullable: true })
  previousRiderId!: string | null;

  @Column({ name: 'offered_by', type: 'uuid' })
  offeredBy!: string;

  @Column({ name: 'offered_at', type: 'timestamptz' })
  offeredAt!: Date;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ type: 'text' })
  status!: 'pending' | 'accepted' | 'declined' | 'expired';

  @Column({ name: 'responded_at', type: 'timestamptz', nullable: true })
  respondedAt!: Date | null;

  @Column({ name: 'vehicle_id', type: 'uuid', nullable: true })
  vehicleId!: string | null;

  @Column({ name: 'vehicle_match', type: 'text', nullable: true })
  vehicleMatch!: 'gps' | 'confirmed' | null;
}

/** Only show offers whose underlying request can still be accepted. */
export function openDeliveryOffers(manager: EntityManager, branchId: string) {
  return manager.createQueryBuilder(DeliveryOffer, 'offer')
    .innerJoin(ServiceRequest, 'request', 'request.id = offer.service_request_id AND request.branch_id = offer.branch_id')
    .where('offer.branch_id = :branchId', { branchId })
    .andWhere("offer.status = 'pending' AND offer.expires_at > now() AND request.deleted_at IS NULL AND request.delivered_at IS NULL")
    .andWhere("(request.payment_method <> 'PayMongo' OR request.payment_status = 'Paid')")
    .andWhere(`(
      (offer.previous_rider_id IS NULL AND request.status = 'Pending' AND request.dispatched_at IS NULL)
      OR (offer.previous_rider_id = request.rider_id AND request.status IN ('Dispatched', 'En Route')
        AND request.dispatched_at IS NOT NULL)
    )`);
}
