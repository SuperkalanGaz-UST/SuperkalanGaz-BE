import { Principal } from '../auth/principal';
import { FleetController } from './fleet.controller';
import { FleetService } from './fleet.service';
import { Rider } from './rider.entity';
import { Vehicle } from './vehicle.entity';

describe('FleetController dispatch location boundary', () => {
  const location = { latitude: 14.45, longitude: 120.98, source: 'phone' as const };
  const rider = Object.assign(new Rider(), { id: 'rider-1', branchId: 'branch-1', name: 'Test Delivery Rider', status: 'Available', plate: 'OLD PLATE' });
  const vehicle = Object.assign(new Vehicle(), {
    id: 'vehicle-1', branchId: 'branch-1', assignedRiderId: rider.id, plateNumber: 'SAVED PLATE', status: 'active',
    hardwareUniqueId: 'private-hardware-id', traccarDeviceId: 'private-device-id',
  });
  function setup() {
    const mocks = {
      listForBranch: jest.fn().mockResolvedValue([rider]),
      currentOrdersForRiders: jest.fn().mockResolvedValue(new Map()),
      assignedVehiclesForRiders: jest.fn().mockResolvedValue(new Map([[rider.id, vehicle]])),
      operationalLocationFor: jest.fn().mockReturnValue(location),
      findByIdForCaller: jest.fn().mockResolvedValue(rider),
    };
    return { mocks, controller: new FleetController(mocks as unknown as FleetService) };
  }
  const principal = (role: Principal['role']): Principal => ({ userId: 'user-1', role, branchIds: ['branch-1'], branches: ['Test branch'] });

  it('shows the Branch Manager a saved vehicle association separately from phone GPS, without hardware identifiers', async () => {
    const { controller, mocks } = setup();
    const manager = principal('branch-manager');
    const result = await controller.list(manager, {});
    expect(mocks.listForBranch).toHaveBeenCalledWith(manager, {});
    expect(mocks.assignedVehiclesForRiders).toHaveBeenCalledWith([rider]);
    expect(result.riders[0]).toMatchObject({
      operational_location: location,
      assigned_vehicle: { id: vehicle.id, plate_number: 'SAVED PLATE', status: 'active' },
    });
    expect(result.riders[0].assigned_vehicle).not.toHaveProperty('hardwareUniqueId');
    expect(result.riders[0].assigned_vehicle).not.toHaveProperty('traccarDeviceId');
  });

  it('does not query or return operational location/vehicle context for the Branch Owner', async () => {
    const { controller, mocks } = setup();
    const result = await controller.list(principal('branch-owner'), {});
    expect(mocks.assignedVehiclesForRiders).not.toHaveBeenCalled();
    expect(mocks.operationalLocationFor).not.toHaveBeenCalled();
    expect(result.riders[0]).not.toHaveProperty('operational_location');
    expect(result.riders[0]).not.toHaveProperty('assigned_vehicle');
  });

  it('keeps the customer-safe detail response free of either location source and vehicle identifiers', async () => {
    const { controller } = setup();
    const result = await controller.detail(principal('customer'), rider.id);
    expect(result.rider).not.toHaveProperty('operational_location');
    expect(result.rider).not.toHaveProperty('assigned_vehicle');
    expect(result.rider).not.toHaveProperty('hardwareUniqueId');
  });
});
