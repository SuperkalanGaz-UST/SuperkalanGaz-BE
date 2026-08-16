import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** DB CHECK-constrained (vehicles_status_check). 'maintenance' is set
 * automatically when current_odometer_km - last_pms_odometer_km reaches the
 * branch's maintenance_threshold_km (story BM-US-09); cleared by a PMS reset. */
export type VehicleStatus = 'active' | 'maintenance' | 'inactive';

/**
 * Maps fleet.vehicles — one row per branch motorcycle, separate from the rider
 * who currently rides it (assigned_rider_id, nullable, no FK by design —
 * AGENTS.md §6). The table already existed in the shared schema (same situation
 * as core.sla_configurations before it); migration 0021 only ADDS the mileage/PMS
 * columns this story needs.
 */
@Entity({ schema: 'fleet', name: 'vehicles' })
export class Vehicle {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'branch_id', type: 'uuid' })
  branchId!: string;

  @Column({ name: 'plate_number', type: 'text' })
  plateNumber!: string;

  @Column({ name: 'vehicle_type', type: 'text', nullable: true })
  vehicleType!: string | null;

  @Column({ name: 'assigned_rider_id', type: 'uuid', nullable: true })
  assignedRiderId!: string | null;

  @Column({ type: 'text', default: 'active' })
  status!: VehicleStatus;

  /** Latest logged odometer reading. Advances only via logMileage's race-safe
   * conditional update — never decreases. */
  @Column({ name: 'current_odometer_km', type: 'int', default: 0 })
  currentOdometerKm!: number;

  /** Odometer reading at the last completed PMS service; the gap against
   * current_odometer_km is what's compared to the branch threshold. */
  @Column({ name: 'last_pms_odometer_km', type: 'int', default: 0 })
  lastPmsOdometerKm!: number;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
