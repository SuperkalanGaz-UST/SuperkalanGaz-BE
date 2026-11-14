import { ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Principal } from '../auth/principal';
import { FleetService } from '../fleet/fleet.service';
import { Rider } from '../fleet/rider.entity';
import { Vehicle } from '../fleet/vehicle.entity';
import { DeliveryOffer } from './delivery-offer.entity';
import { DeliveryOffersService } from './delivery-offers.service';
import { ServiceRequest } from './service-request.entity';
import { ServiceRequestStatusHistory } from './service-request-status-history.entity';

describe('delivery offers and motorcycle assignment', () => {
  const branchId = 'branch-a';
  const rider = { id: 'rider-a', authUserId: 'driver-a', status: 'Available' };
  const driver: Principal = { role: 'driver', userId: rider.authUserId, branchIds: [branchId], branches: [] };
  const staff: Principal = { ...driver, userId: 'manager-a', role: 'branch-manager' };

  const motorcycle = (id: string, deviceId: string, plateNumber: string) =>
    ({ id, branchId, traccarDeviceId: deviceId, hardwareUniqueId: `hardware-${id}`, plateNumber }) as Vehicle;

  function setup() {
    const request = {
      id: 'request-a', branchId, status: 'Pending', dispatchedAt: null, deliveredAt: null,
      paymentMethod: 'Cash on Delivery', riderId: null,
    };
    const offer = {
      id: 'offer-a', branchId, riderId: rider.id, serviceRequestId: request.id,
      previousRiderId: null, status: 'pending', expiresAt: new Date(Date.now() + 30_000),
    };
    const first = motorcycle('vehicle-a', '41', 'AA-100');
    const second = motorcycle('vehicle-b', '42', 'BB-200');
    const manager = {
      findOne: jest.fn().mockImplementation((entity) => {
        if (entity === ServiceRequest) return request;
        if (entity === Rider) return rider;
        if (entity === Vehicle) return first;
        return null;
      }),
      find: jest.fn().mockResolvedValue([]),
      findOneBy: jest.fn().mockResolvedValue(offer),
      findOneByOrFail: jest.fn().mockResolvedValue(offer),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      create: jest.fn((_entity, value) => value),
      save: jest.fn(),
    };
    const db = { manager, transaction: jest.fn(work => work(manager)) };
    const fleet = {
      findByAuthUserInBranch: jest.fn().mockResolvedValue(rider),
      dispatchMotorcycles: jest.fn().mockResolvedValue([first, second]),
      operationalLocationFor: jest.fn().mockReturnValue({
        latitude: 14.6, longitude: 121, accuracyM: 9, capturedAt: new Date(), receivedAt: new Date(),
      }),
      dispatchMotorcyclePositions: jest.fn().mockResolvedValue([
        { deviceId: '41', latitude: 14.6, longitude: 121, positionAt: new Date() },
        { deviceId: '42', latitude: 14.61, longitude: 121, positionAt: new Date() },
      ]),
      releaseDeliveryVehicle: jest.fn(),
    };
    return {
      service: new DeliveryOffersService(db as unknown as DataSource, fleet as unknown as FleetService),
      db, fleet, manager, request, offer, first, second,
    };
  }

  it('sends an offer without assigning a motorcycle, changing the rider, or stamping dispatch', async () => {
    const { service, request, manager } = setup();
    await expect(service.offer(staff, request.id, rider.id)).resolves.toBe(request);
    expect(manager.save).toHaveBeenCalledWith(DeliveryOffer, expect.objectContaining({
      branchId, riderId: rider.id, offeredBy: staff.userId, status: 'pending',
    }));
    expect(manager.update).not.toHaveBeenCalled();
    expect(request.dispatchedAt).toBeNull();
  });

  it('claims the only nearby motorcycle and stamps dispatch in the same transaction', async () => {
    const { service, db, manager, offer, first } = setup();
    await expect(service.accept(driver, offer.id)).resolves.toEqual({ vehicleChoices: null });
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(manager.findOne).toHaveBeenCalledWith(Vehicle, expect.objectContaining({
      where: expect.objectContaining({ id: first.id, branchId, status: 'active', traccarDeviceId: '41' }),
      lock: { mode: 'pessimistic_write' },
    }));
    expect(manager.update).toHaveBeenCalledWith(DeliveryOffer, expect.objectContaining({ branchId, riderId: rider.id }),
      expect.objectContaining({ status: 'accepted', vehicleId: first.id, vehicleMatch: 'gps' }));
    expect(manager.update).toHaveBeenCalledWith(ServiceRequest, { id: 'request-a', branchId },
      expect.objectContaining({ status: 'Dispatched', dispatchedAt: expect.any(Date) }));
    expect(manager.update).toHaveBeenCalledWith(Rider, { id: rider.id, branchId },
      expect.objectContaining({ status: 'On Delivery', plate: first.plateNumber }));
    expect(manager.save).toHaveBeenCalledWith(ServiceRequestStatusHistory, expect.objectContaining({ changedBy: driver.userId }));
  });

  it.each(['nearby', 'stale', 'outage'])('requires plate confirmation for %s GPS', async (condition) => {
    const { service, db, fleet, offer, first, second } = setup();
    if (condition === 'outage') fleet.dispatchMotorcyclePositions.mockRejectedValueOnce(new Error('unavailable'));
    else fleet.dispatchMotorcyclePositions.mockResolvedValueOnce([
      { deviceId: '41', latitude: 14.6, longitude: 121, positionAt: new Date() },
      { deviceId: '42', latitude: 14.6, longitude: 121, positionAt: new Date(condition === 'stale' ? 0 : Date.now()) },
    ]);
    await expect(service.accept(driver, offer.id)).resolves.toEqual({
      vehicleChoices: [first, second].map(vehicle => ({ id: vehicle.id, label: vehicle.plateNumber })),
    });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('accepts only an eligible same-branch choice and records who confirmed it', async () => {
    const { service, db, fleet, manager, offer, first } = setup();
    await expect(service.accept(driver, offer.id, 'different-branch-motorcycle')).rejects.toBeInstanceOf(ConflictException);
    expect(db.transaction).not.toHaveBeenCalled();
    await expect(service.accept(driver, offer.id, first.id)).resolves.toEqual({ vehicleChoices: null });
    expect(fleet.dispatchMotorcyclePositions).not.toHaveBeenCalled();
    expect(manager.update).toHaveBeenCalledWith(DeliveryOffer, expect.anything(),
      expect.objectContaining({ vehicleId: first.id, vehicleMatch: 'confirmed' }));
  });

  it('leaves the offer open if another acceptance claimed the motorcycle first', async () => {
    const { service, manager, offer, first } = setup();
    manager.findOne.mockImplementation(entity => entity === ServiceRequest
      ? { id: 'request-a', status: 'Pending', paymentMethod: 'Cash on Delivery' } : null);
    await expect(service.accept(driver, offer.id, first.id)).rejects.toBeInstanceOf(ConflictException);
    expect(manager.update).not.toHaveBeenCalled();
  });

  it('rejects another rider’s offer and an expired offer before calling GPS', async () => {
    const { service, fleet, manager, offer } = setup();
    manager.findOneBy.mockResolvedValueOnce(null);
    await expect(service.accept(driver, offer.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.accept(driver, offer.id)).resolves.toEqual({ vehicleChoices: null });
    offer.expiresAt = new Date(0);
    fleet.dispatchMotorcyclePositions.mockClear();
    await expect(service.accept(driver, offer.id)).rejects.toBeInstanceOf(ConflictException);
    expect(fleet.dispatchMotorcyclePositions).not.toHaveBeenCalled();
  });

  it('declines a live offer without changing the Service Request or motorcycle', async () => {
    const { service, manager, offer } = setup();
    await service.decline(driver, offer.id);
    expect(manager.update).toHaveBeenCalledTimes(1);
    expect(manager.update).toHaveBeenCalledWith(DeliveryOffer, expect.objectContaining({ branchId, riderId: rider.id }),
      expect.objectContaining({ status: 'declined' }));
  });

  it('keeps the original SLA timestamp when replacing an active Delivery Rider', async () => {
    const { service, manager, fleet, offer, request, first } = setup();
    const original = new Date(Date.now() - 60_000);
    Object.assign(request, { status: 'En Route', dispatchedAt: original, riderId: 'old-rider' });
    Object.assign(offer, { previousRiderId: 'old-rider' });
    await service.accept(driver, offer.id, first.id);
    expect(fleet.releaseDeliveryVehicle).toHaveBeenCalledWith(manager, branchId, 'old-rider', expect.any(Date));
    expect(manager.update).toHaveBeenCalledWith(ServiceRequest, { id: request.id, branchId },
      expect.objectContaining({ status: 'En Route', dispatchedAt: original }));
  });
});
