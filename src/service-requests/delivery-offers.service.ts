import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, In, IsNull, MoreThan } from 'typeorm';
import { Principal } from '../auth/principal';
import { FleetService } from '../fleet/fleet.service';
import { Rider } from '../fleet/rider.entity';
import { Vehicle } from '../fleet/vehicle.entity';
import { DeliveryOffer, openDeliveryOffers } from './delivery-offer.entity';
import { ServiceRequest } from './service-request.entity';
import { ServiceRequestStatusHistory } from './service-request-status-history.entity';

const OFFER_DURATION_MS = 5 * 60_000;
const PHONE_FIX_MAX_AGE_MS = 60_000;
const VEHICLE_FIX_MAX_AGE_MS = 120_000;
const MAX_PHONE_ACCURACY_M = 35;
const MATCH_RADIUS_M = 40;

function distanceM(lat: number, lng: number, otherLat: number, otherLng: number): number {
  const radians = Math.PI / 180;
  const distance = Math.sin((otherLat - lat) * radians / 2) ** 2 +
    Math.cos(lat * radians) * Math.cos(otherLat * radians) * Math.sin((otherLng - lng) * radians / 2) ** 2;
  return 12_742_000 * Math.asin(Math.sqrt(Math.min(1, distance)));
}

@Injectable()
export class DeliveryOffersService {
  constructor(private readonly db: DataSource, private readonly fleet: FleetService) {}

  async listOpen(principal: Principal) {
    const branchId = this.branchId(principal);
    return openDeliveryOffers(this.db.manager, branchId).getMany();
  }

  async offer(principal: Principal, requestId: string, riderId: string, reassign = false) {
    const branchId = this.branchId(principal);
    return this.db.transaction(async manager => {
      const request = await this.lockRequest(manager, branchId, requestId);
      const previousRiderId = reassign ? request.riderId : null;
      this.assertOfferable(request, previousRiderId, reassign);
      if (riderId === previousRiderId) throw new BadRequestException('Select another Delivery Rider');

      const rider = await manager.findOne(Rider, {
        where: { id: riderId, branchId, status: 'Available', deletedAt: IsNull() },
        lock: { mode: 'pessimistic_write' },
      });
      if (!rider?.authUserId) throw new ConflictException('This Delivery Rider is no longer available');

      const now = new Date();
      const pending = await manager.find(DeliveryOffer, { where: [
        { branchId, serviceRequestId: requestId, status: 'pending' },
        { branchId, riderId, status: 'pending' },
      ] });
      if (pending.length > 0) {
        const live = await openDeliveryOffers(manager, branchId)
          .andWhere('offer.id IN (:...ids)', { ids: pending.map(offer => offer.id) }).getMany();
        if (live.some(offer => offer.serviceRequestId === requestId && offer.riderId === riderId && offer.previousRiderId === previousRiderId)) return request;
        if (live.length) throw new ConflictException('The Service Request or Delivery Rider already has an open offer');
        await manager.update(DeliveryOffer, { branchId, id: In(pending.map(offer => offer.id)), status: 'pending' },
          { status: 'expired', respondedAt: now });
      }

      await manager.save(DeliveryOffer, manager.create(DeliveryOffer, {
        branchId, serviceRequestId: requestId, riderId, previousRiderId,
        offeredBy: principal.userId, offeredAt: now, expiresAt: new Date(now.getTime() + OFFER_DURATION_MS),
        status: 'pending',
      }));
      return request;
    });
  }

  async accept(principal: Principal, offerId: string, confirmedVehicleId?: string) {
    const { branchId, rider, offer } = await this.riderOffer(principal, offerId);
    if (offer.status === 'accepted') return { vehicleChoices: null };
    this.assertPending(offer);
    if (rider.status !== 'Available') throw new ConflictException('Go Available before accepting the offer');

    const candidates = await this.fleet.dispatchMotorcycles(branchId, offer.previousRiderId);
    const vehicle = confirmedVehicleId
      ? candidates.find(candidate => candidate.id === confirmedVehicleId)
      : await this.matchMotorcycle(rider, candidates);
    if (!vehicle) {
      if (confirmedVehicleId) throw new ConflictException('That motorcycle is unavailable. Refresh the choices and try again.');
      if (!candidates.length) throw new ConflictException('No healthy GPS-equipped motorcycle is available in your branch.');
      return { vehicleChoices: candidates.map(candidate => ({ id: candidate.id, label: candidate.plateNumber })) };
    }

    await this.db.transaction(async manager => {
      const request = await this.lockRequest(manager, branchId, offer.serviceRequestId);
      const current = await manager.findOneByOrFail(DeliveryOffer, { id: offer.id, branchId, riderId: rider.id });
      if (current.status === 'accepted') return;
      this.assertPending(current);
      this.assertOfferable(request, current.previousRiderId, current.previousRiderId !== null);

      if (vehicle.assignedRiderId && vehicle.assignedRiderId !== current.previousRiderId) {
        throw new ConflictException('That motorcycle is no longer available. Check the motorcycles again.');
      }
      const { traccarDeviceId, hardwareUniqueId } = vehicle;
      if (!traccarDeviceId || !hardwareUniqueId) throw new ConflictException('This motorcycle has no registered GPS device');
      const motorcycle = await manager.findOne(Vehicle, {
        where: { id: vehicle.id, branchId, assignedRiderId: vehicle.assignedRiderId ?? IsNull(), status: 'active',
          traccarProvisioningStatus: 'provisioned', traccarDeviceId, hardwareUniqueId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!motorcycle) throw new ConflictException('That motorcycle is no longer available. Check the motorcycles again.');
      const activeRider = await manager.findOne(Rider, {
        where: { id: rider.id, authUserId: principal.userId, branchId, status: 'Available', deletedAt: IsNull() },
        lock: { mode: 'pessimistic_write' },
      });
      if (!activeRider) throw new ConflictException('Go Available before accepting the offer');
      this.assertPending(current);
      const now = new Date();
      const claimed = await manager.update(DeliveryOffer, {
        id: offer.id, branchId, riderId: rider.id, status: 'pending', expiresAt: MoreThan(now),
      }, { status: 'accepted', respondedAt: now, vehicleId: motorcycle.id, vehicleMatch: confirmedVehicleId ? 'confirmed' : 'gps' });
      if (!claimed.affected) throw new ConflictException('This delivery offer is no longer open');

      const status = current.previousRiderId ? request.status : 'Dispatched';
      if (current.previousRiderId) await this.fleet.releaseDeliveryVehicle(manager, branchId, current.previousRiderId, now);
      await manager.update(Vehicle, { id: motorcycle.id, branchId }, { assignedRiderId: rider.id, updatedAt: now });
      await manager.update(Rider, { id: rider.id, branchId }, { status: 'On Delivery', plate: motorcycle.plateNumber, updatedAt: now });
      await manager.update(ServiceRequest, { id: request.id, branchId }, {
        status, riderId: rider.id, dispatchedAt: request.dispatchedAt ?? now, updatedAt: now,
      });
      await manager.save(ServiceRequestStatusHistory, manager.create(ServiceRequestStatusHistory, {
        serviceRequestId: request.id, branchId, fromStatus: request.status, toStatus: status,
        changedBy: principal.userId, changedAt: now,
        note: `Delivery Rider accepted with motorcycle ${motorcycle.plateNumber} (${confirmedVehicleId ? 'confirmed' : 'matched by GPS'})`,
      }));
    });

    return { vehicleChoices: null };
  }

  async decline(principal: Principal, offerId: string): Promise<void> {
    const { branchId, rider, offer } = await this.riderOffer(principal, offerId);
    if (offer.status === 'declined') return;
    await this.db.transaction(async manager => {
      await this.lockRequest(manager, branchId, offer.serviceRequestId);
      const now = new Date();
      const result = await manager.update(DeliveryOffer, {
        id: offerId, branchId, riderId: rider.id, status: 'pending', expiresAt: MoreThan(now),
      }, { status: 'declined', respondedAt: now });
      if (!result.affected) throw new ConflictException('This delivery offer is no longer open');
    });
  }

  private async matchMotorcycle(rider: Rider, candidates: Vehicle[]): Promise<Vehicle | undefined> {
    const phone = this.fleet.operationalLocationFor(rider);
    const accuracy = phone?.accuracyM;
    if (!phone || typeof accuracy !== 'number' || !Number.isFinite(accuracy) || accuracy < 0 || accuracy > MAX_PHONE_ACCURACY_M ||
        !this.isFresh(phone.capturedAt, PHONE_FIX_MAX_AGE_MS) || !this.isFresh(phone.receivedAt, PHONE_FIX_MAX_AGE_MS) ||
        candidates.length === 0 || candidates.length > 100) return;

    const positions = await this.fleet.dispatchMotorcyclePositions(candidates).catch(() => []);
    const fresh = new Map(positions.filter(position => this.isFresh(position.positionAt, VEHICLE_FIX_MAX_AGE_MS))
      .map(position => [position.deviceId, position]));
    // A missing fix could be another motorcycle parked nearby.
    const nearby: Vehicle[] = [];
    for (const vehicle of candidates) {
      const position = fresh.get(vehicle.traccarDeviceId ?? '');
      if (!position) return;
      if (distanceM(phone.latitude, phone.longitude, position.latitude, position.longitude) <= MATCH_RADIUS_M + accuracy) {
        nearby.push(vehicle);
      }
    }
    return nearby.length === 1 ? nearby[0] : undefined;
  }

  private isFresh(time: Date, maximumAgeMs: number): boolean {
    const age = Date.now() - time.getTime();
    return age >= -5_000 && age <= maximumAgeMs;
  }

  private async riderOffer(principal: Principal, id: string) {
    const branchId = this.branchId(principal);
    const rider = await this.fleet.findByAuthUserInBranch(principal.userId, branchId);
    const offer = rider && await this.db.manager.findOneBy(DeliveryOffer, { id, branchId, riderId: rider.id });
    if (!rider || !offer) throw new NotFoundException('Delivery offer not found');
    return { branchId, rider, offer };
  }

  private async lockRequest(manager: EntityManager, branchId: string, id: string): Promise<ServiceRequest> {
    const request = await manager.findOne(ServiceRequest, {
      where: { id, branchId, deletedAt: IsNull() }, lock: { mode: 'pessimistic_write' },
    });
    if (!request) throw new NotFoundException('Service Request not found');
    return request;
  }

  private assertOfferable(request: ServiceRequest, previousRiderId: string | null, reassign: boolean) {
    if (request.paymentMethod === 'PayMongo' && request.paymentStatus !== 'Paid') {
      throw new ConflictException('PayMongo payment is required before dispatch');
    }
    if (reassign) {
      if (!previousRiderId || request.riderId !== previousRiderId || !request.dispatchedAt ||
          request.deliveredAt || !['Dispatched', 'En Route'].includes(request.status)) {
        throw new ConflictException('The Service Request is no longer eligible for reassignment');
      }
      return;
    }
    if (request.status !== 'Pending' || request.dispatchedAt || request.deliveredAt) {
      throw new ConflictException('The Service Request is no longer eligible for dispatch');
    }
  }

  private assertPending(offer: DeliveryOffer) {
    if (offer.status !== 'pending' || offer.expiresAt.getTime() <= Date.now()) {
      throw new ConflictException('This delivery offer is no longer open');
    }
  }

  private branchId(principal: Principal): string {
    if (principal.branchIds.length !== 1) throw new ForbiddenException('An active branch is required');
    return principal.branchIds[0];
  }
}
