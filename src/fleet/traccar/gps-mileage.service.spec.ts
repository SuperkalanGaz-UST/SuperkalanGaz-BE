import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { Principal } from '../../auth/principal';
import { Branch } from '../../branches/branch.entity';
import { Rider } from '../rider.entity';
import { Vehicle } from '../vehicle.entity';
import { GpsMileageService } from './gps-mileage.service';
import { TraccarClient } from './traccar.client';

describe('request-bound GPS mileage sync', () => {
  const principal: Principal = { userId: 'bm', role: 'branch-manager', branches: ['A'], branchIds: ['branch-a'] };
  const make = (claimed = true, settings: Record<string, string> = {}) => {
    const state = {
      vehicle_id: 'vehicle-a', branch_id: 'branch-a', device_id: '41', total_distance_m: 10_000,
      remainder_m: 100, position_at: new Date('2026-01-01T00:00:00Z'),
      baseline_after: new Date('2025-12-31T00:00:00Z'), synced_at: null,
      next_poll_at: new Date(), status: 'synced',
    };
    const vehicle = {
      id: 'vehicle-a', branchId: 'branch-a', traccarDeviceId: '41', hardwareUniqueId: 'hardware-41',
      status: 'active', traccarProvisioningStatus: 'provisioned', currentOdometerKm: 2999,
      lastPmsOdometerKm: 0, assignedRiderId: 'rider-a',
    };
    const manager = {
      findOne: jest.fn(async (entity: unknown) => entity === Vehicle ? vehicle : { maintenanceThresholdKm: 3000 }),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      query: jest.fn(async (sql: string) => sql.includes('SELECT') ? [state] : []),
    };
    const db = {
      query: jest.fn(async (sql: string) => sql.includes('INSERT') ? (claimed ? [state] : []) : sql.includes('SELECT') ? [state] : []),
      getRepository: jest.fn(() => ({ find: jest.fn().mockResolvedValue([vehicle]) })),
      transaction: jest.fn((work: (value: typeof manager) => Promise<void>) => work(manager)),
    };
    const traccar = { latestDistances: jest.fn().mockResolvedValue([
      { deviceId: '41', totalDistanceM: 11_500, positionAt: new Date('2026-01-01T00:05:00Z') },
    ]) };
    const service = new GpsMileageService(db as unknown as DataSource, traccar as unknown as TraccarClient, {
      get: (key: string) => settings[key],
    } as ConfigService);
    return { state, vehicle, manager, db, traccar, service };
  };

  it.each(['customer', 'driver', 'branch-owner', 'franchise-admin', 'super-admin'] as const)(
    'rejects %s before any telemetry or data access', async (role) => {
      const { service, db, traccar } = make();
      await expect(service.refresh({ ...principal, role })).rejects.toThrow('authorized Branch Manager');
      expect(db.query).not.toHaveBeenCalled();
      expect(traccar.latestDistances).not.toHaveBeenCalled();
    },
  );

  it('rejects missing or multiple branch assignments', async () => {
    const { service, db } = make();
    for (const branchIds of [[], ['branch-a', 'branch-b']]) {
      await expect(service.refresh({ ...principal, branchIds })).rejects.toThrow();
    }
    expect(db.query).not.toHaveBeenCalled();
  });

  it('shares the database cooldown without another Traccar read', async () => {
    const { service, traccar, db } = make(false);
    await service.refresh(principal);
    expect(traccar.latestDistances).not.toHaveBeenCalled();
    expect(db.query.mock.calls[0][0]).toContain('cache.next_poll_at <= now()');
    expect(db.query.mock.calls[0]).toEqual([expect.any(String), ['branch-a', 300_000]]);
  });

  it('keeps every vehicle, state and rider mutation within the authenticated branch', async () => {
    const { service, db, manager, traccar } = make();
    await service.refresh(principal);
    expect(traccar.latestDistances).toHaveBeenCalledWith([{ id: '41', uniqueId: 'hardware-41' }]);
    expect(manager.findOne).toHaveBeenCalledWith(Vehicle, {
      where: { id: 'vehicle-a', branchId: 'branch-a', traccarDeviceId: '41' }, lock: { mode: 'pessimistic_write' },
    });
    expect(manager.findOne).toHaveBeenCalledWith(Branch, { where: { id: 'branch-a' } });
    expect(manager.update).toHaveBeenCalledWith(Vehicle, { id: 'vehicle-a', branchId: 'branch-a' },
      expect.objectContaining({ currentOdometerKm: 3000, status: 'maintenance' }));
    expect(manager.update).toHaveBeenCalledWith(Rider, { id: 'rider-a', branchId: 'branch-a', status: 'Available' },
      expect.objectContaining({ status: 'Maintenance Due', operationalLatitude: null }));
    expect(db.query.mock.calls.at(-1)).toEqual([expect.stringContaining('WHERE branch_id = $1'), ['branch-a']]);
  });

  it('keeps the roster available on timeout and marks cached mileage unavailable', async () => {
    const { service, traccar, db, manager } = make();
    traccar.latestDistances.mockRejectedValueOnce(new Error('upstream unavailable'));
    await expect(service.refresh(principal)).resolves.toBeInstanceOf(Map);
    expect(manager.update).not.toHaveBeenCalled();
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("status = 'unavailable'"), ['branch-a', ['vehicle-a']]);
  });

  it('does not advance odometer when a report duplicates the persisted cursor', async () => {
    const { service, traccar, manager, state } = make();
    traccar.latestDistances.mockResolvedValueOnce([{ deviceId: '41', totalDistanceM: state.total_distance_m, positionAt: state.position_at }]);
    await service.refresh(principal);
    expect(manager.update).not.toHaveBeenCalled();
    expect(manager.query).toHaveBeenCalledWith(expect.stringContaining('failures = 0'), ['vehicle-a', 'branch-a']);
  });

  it('uses the locked latest PMS baseline rather than a stale prefetch', async () => {
    const { service, manager, vehicle } = make();
    vehicle.lastPmsOdometerKm = 2999;
    await service.refresh(principal);
    expect(manager.update).toHaveBeenCalledWith(Vehicle, expect.anything(), expect.objectContaining({ currentOdometerKm: 3000 }));
    expect(manager.update.mock.calls.some(([entity]) => entity === Rider)).toBe(false);
  });

  it('preserves odometer after manual recalibration until a new fix establishes a baseline', async () => {
    const { service, manager, state } = make();
    state.baseline_after = new Date('2026-01-01T00:06:00Z');
    await service.refresh(principal);
    expect(manager.update).not.toHaveBeenCalled();
  });

  it('can be disabled without querying the migration table or Traccar', async () => {
    const { service, db } = make(true, { TRACCAR_MILEAGE_SYNC_ENABLED: 'false' });
    expect(await service.refresh(principal)).toEqual(new Map());
    expect(db.query).not.toHaveBeenCalled();
  });

  it.each(['0', '15000', 'NaN', '3600001'])('rejects unsafe polling interval %s', (interval) => {
    expect(make(false, { TRACCAR_MILEAGE_INTERVAL_MS: interval }).service.intervalMs).toBe(300_000);
  });
});
