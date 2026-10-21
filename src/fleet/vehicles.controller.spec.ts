import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Principal } from '../auth/principal';
import { RolesGuard } from '../auth/roles.guard';
import { FleetService } from './fleet.service';
import { GpsMileageService } from './traccar/gps-mileage.service';
import { VehiclesController } from './vehicles.controller';

describe('VehiclesController read-only access', () => {
  const owner: Principal = { userId: 'owner-1', role: 'branch-owner', branches: ['Alpha'], branchIds: ['branch-1'] };
  const guard = new RolesGuard(new Reflector());
  const context = (method: keyof VehiclesController, principal: Principal): ExecutionContext => ({
    getHandler: () => VehiclesController.prototype[method],
    getClass: () => VehiclesController,
    switchToHttp: () => ({ getRequest: () => ({ principal }) }),
  } as unknown as ExecutionContext);

  it.each(['list', 'detail'] as const)('allows Owner reads through %s', method => {
    expect(guard.canActivate(context(method, owner))).toBe(true);
  });

  it.each(['create', 'connectGps', 'retryGpsProvisioning', 'logMileage', 'resetPms'] as const)(
    'denies Owner writes through %s while preserving Manager access', method => {
      expect(() => guard.canActivate(context(method, owner))).toThrow(ForbiddenException);
      expect(guard.canActivate(context(method, { ...owner, role: 'branch-manager' }))).toBe(true);
    },
  );

  it.each(['customer', 'driver', 'franchise-admin', 'super-admin'] as const)('does not open vehicle reads to %s', role => {
    for (const method of ['list', 'detail'] as const) {
      expect(() => guard.canActivate(context(method, { ...owner, role }))).toThrow(ForbiddenException);
    }
  });

  it('passes selected UUIDs into roster/detail/history reads without triggering GPS writes', async () => {
    const fleet = {
      listVehiclesForBranch: jest.fn().mockResolvedValue([]),
      riderNamesFor: jest.fn().mockResolvedValue(new Map()),
      maintenanceThresholdsForBranches: jest.fn().mockResolvedValue(new Map()),
      getVehicle: jest.fn().mockResolvedValue({ id: 'vehicle-1', branchId: 'branch-1', assignedRiderId: null }),
      listMaintenanceLogs: jest.fn().mockResolvedValue([]),
    };
    const gpsMileage = { refresh: jest.fn(), intervalMs: 300_000 };
    const controller = new VehiclesController(
      fleet as unknown as FleetService,
      gpsMileage as unknown as GpsMileageService,
    );
    await controller.list(owner, { branchId: 'branch-1' });
    await controller.detail(owner, 'vehicle-1', { branchId: 'branch-1' });
    expect(fleet.listVehiclesForBranch).toHaveBeenCalledWith(owner, 'branch-1');
    expect(fleet.getVehicle).toHaveBeenCalledWith(owner, 'vehicle-1', 'branch-1');
    expect(fleet.listMaintenanceLogs).toHaveBeenCalledWith(owner, 'vehicle-1', 'branch-1');
    expect(gpsMileage.refresh).not.toHaveBeenCalled();
  });
});
