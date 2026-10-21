import { ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { Principal } from '../../auth/principal';
import { Branch } from '../../branches/branch.entity';
import { Rider } from '../rider.entity';
import { Vehicle } from '../vehicle.entity';
import { advanceMileage } from './gps-mileage';
import { TraccarClient } from './traccar.client';

interface MileageState {
  vehicle_id: string;
  branch_id: string;
  device_id: string;
  total_distance_m: number | null;
  remainder_m: number;
  position_at: Date | null;
  baseline_after: Date;
  synced_at: Date | null;
  next_poll_at: Date;
  status: 'waiting' | 'synced' | 'unavailable' | 'counter-reset';
}

export interface GpsMileageInfo {
  status: MileageState['status'] | 'stale' | 'disabled';
  position_at: Date | null;
  synced_at: Date | null;
}

/** Request-bound telemetry materialization. No timer, background CPU, browser
 * Traccar access, or unscoped system principal. The DB lease survives cold starts
 * and is shared by replicas/tabs. Failed reads back off without blocking the roster. */
@Injectable()
export class GpsMileageService {
  constructor(
    private readonly db: DataSource,
    private readonly traccar: TraccarClient,
    private readonly config: ConfigService,
  ) {}

  get intervalMs(): number {
    const value = Number(this.config.get<string>('TRACCAR_MILEAGE_INTERVAL_MS'));
    return Number.isInteger(value) && value >= 60_000 && value <= 3_600_000 ? value : 300_000;
  }

  get enabled(): boolean {
    return this.config.get<string>('TRACCAR_MILEAGE_SYNC_ENABLED') !== 'false';
  }

  async refresh(principal: Principal): Promise<Map<string, GpsMileageInfo>> {
    if (principal.role !== 'branch-manager' || principal.branchIds.length !== 1) {
      throw new ForbiddenException('A single authorized Branch Manager scope is required');
    }
    const branchId = principal.branchIds[0];
    if (!this.enabled) return new Map();

    // Claim only due, registered vehicles in the guard-resolved branch. Backoff
    // is persisted; refreshing the page or starting a new instance cannot bypass it.
    const claimed: MileageState[] = await this.db.query(`
      INSERT INTO fleet.vehicle_gps_mileage AS cache (vehicle_id, branch_id, device_id, baseline_after, next_poll_at)
      SELECT v.id, v.branch_id, v.traccar_device_id, COALESCE(v.traccar_provisioned_at, now()),
        now() + ($2 * power(2, LEAST(COALESCE(s.failures, 0), 3))) * interval '1 millisecond'
      FROM fleet.vehicles v
      LEFT JOIN fleet.vehicle_gps_mileage s ON s.vehicle_id = v.id AND s.branch_id = v.branch_id
      WHERE v.branch_id = $1 AND v.traccar_provisioning_status = 'provisioned'
        AND v.traccar_device_id IS NOT NULL AND v.hardware_unique_id IS NOT NULL AND v.status <> 'inactive'
        AND (s.vehicle_id IS NULL OR s.next_poll_at <= now() OR s.device_id <> v.traccar_device_id)
      ORDER BY v.id LIMIT 100
      ON CONFLICT (vehicle_id) DO UPDATE SET
        device_id = EXCLUDED.device_id,
        total_distance_m = CASE WHEN cache.device_id = EXCLUDED.device_id THEN cache.total_distance_m END,
        remainder_m = CASE WHEN cache.device_id = EXCLUDED.device_id THEN cache.remainder_m ELSE 0 END,
        position_at = CASE WHEN cache.device_id = EXCLUDED.device_id THEN cache.position_at END,
        baseline_after = CASE WHEN cache.device_id = EXCLUDED.device_id THEN cache.baseline_after ELSE now() END,
        status = CASE WHEN cache.device_id = EXCLUDED.device_id THEN cache.status ELSE 'waiting' END,
        next_poll_at = EXCLUDED.next_poll_at
      WHERE cache.branch_id = $1 AND (cache.next_poll_at <= now() OR cache.device_id <> EXCLUDED.device_id)
      RETURNING cache.*
    `, [branchId, this.intervalMs]);

    if (claimed.length > 0) {
      try {
        const vehicles = await this.db.getRepository(Vehicle).find({
          where: { branchId },
        });
        const hardware = new Map(vehicles.map((v) => [v.id, v.hardwareUniqueId]));
        const devices = claimed.flatMap((state) => {
          const uniqueId = hardware.get(state.vehicle_id);
          return uniqueId ? [{ id: state.device_id, uniqueId }] : [];
        });
        const readings = await this.traccar.latestDistances(devices);
        const byDevice = new Map(readings.map((reading) => [reading.deviceId, reading]));
        for (const claim of claimed) {
          const reading = byDevice.get(claim.device_id);
          if (!reading) {
            await this.markUnavailable(branchId, [claim.vehicle_id]);
            continue;
          }
          await this.db.transaction(async (manager) => {
            // Serialize against manual readings and PMS resets. Never save an
            // old entity over a concurrent higher odometer or a new PMS baseline.
            const vehicle = await manager.findOne(Vehicle, {
              where: { id: claim.vehicle_id, branchId, traccarDeviceId: claim.device_id },
              lock: { mode: 'pessimistic_write' },
            });
            if (!vehicle || vehicle.status === 'inactive' || vehicle.traccarProvisioningStatus !== 'provisioned') return;
            const states: MileageState[] = await manager.query(
              'SELECT * FROM fleet.vehicle_gps_mileage WHERE vehicle_id = $1 AND branch_id = $2 AND device_id = $3 FOR UPDATE',
              [vehicle.id, branchId, claim.device_id],
            );
            const state = states[0];
            if (!state) return;
            const change = advanceMileage({
              totalDistanceM: state.total_distance_m,
              remainderM: state.remainder_m,
              positionAt: state.position_at,
              baselineAfter: state.baseline_after,
            }, reading);
            if (!change) {
              if (state.position_at && reading.positionAt.getTime() === state.position_at.getTime()
                && reading.totalDistanceM === state.total_distance_m) {
                await manager.query(`
                  UPDATE fleet.vehicle_gps_mileage SET synced_at = now(), status = 'synced', failures = 0
                  WHERE vehicle_id = $1 AND branch_id = $2
                `, [vehicle.id, branchId]);
              } else if (reading.positionAt.getTime() >= state.baseline_after.getTime()) {
                await manager.query(`
                  UPDATE fleet.vehicle_gps_mileage SET status = 'unavailable', failures = LEAST(failures + 1, 3)
                  WHERE vehicle_id = $1 AND branch_id = $2
                `, [vehicle.id, branchId]);
              }
              return;
            }
            // PostgreSQL integer limit; malformed telemetry must not overflow a
            // saved odometer or keep a transaction in a failed state.
            if (vehicle.currentOdometerKm + change.kilometres > 2_147_483_647) return;
            const branch = await manager.findOne(Branch, { where: { id: branchId } });
            if (!branch) return;
            const odometerKm = vehicle.currentOdometerKm + change.kilometres;
            const due = odometerKm - vehicle.lastPmsOdometerKm >= branch.maintenanceThresholdKm;
            if (change.kilometres > 0 || (due && vehicle.status !== 'maintenance')) {
              await manager.update(Vehicle, { id: vehicle.id, branchId }, {
                currentOdometerKm: odometerKm,
                ...(due ? { status: 'maintenance' as const } : {}),
                updatedAt: new Date(),
              });
            }
            if (due && vehicle.assignedRiderId) {
              await manager.update(Rider, { id: vehicle.assignedRiderId, branchId, status: 'Available' }, {
                status: 'Maintenance Due', updatedAt: new Date(),
                operationalLatitude: null, operationalLongitude: null,
                operationalAccuracyM: null, operationalLocationCapturedAt: null, operationalLocationReceivedAt: null,
              });
            }
            await manager.query(`
              UPDATE fleet.vehicle_gps_mileage SET total_distance_m = $3, remainder_m = $4,
                position_at = $5, synced_at = now(), status = $6, failures = 0
              WHERE vehicle_id = $1 AND branch_id = $2
            `, [vehicle.id, branchId, change.totalDistanceM, change.remainderM, change.positionAt, change.status]);
          });
        }
      } catch {
        // Preserve authoritative saved mileage and an explicit unavailable state.
        // No upstream body, credentials or coordinates are exposed or logged.
        await this.markUnavailable(branchId, claimed.map((state) => state.vehicle_id));
      }
    }
    const states: MileageState[] = await this.db.query(
      'SELECT * FROM fleet.vehicle_gps_mileage WHERE branch_id = $1', [branchId],
    );
    return new Map(states.map((state) => [state.vehicle_id, {
      status: state.status === 'synced' && state.position_at && Date.now() - state.position_at.getTime() > 900_000
        ? 'stale' : state.status,
      position_at: state.position_at,
      synced_at: state.synced_at,
    }]));
  }

  private async markUnavailable(branchId: string, vehicleIds: string[]): Promise<void> {
    await this.db.query(`
      UPDATE fleet.vehicle_gps_mileage SET status = 'unavailable', failures = LEAST(failures + 1, 3)
      WHERE branch_id = $1 AND vehicle_id = ANY($2::uuid[])
    `, [branchId, vehicleIds]);
  }
}
