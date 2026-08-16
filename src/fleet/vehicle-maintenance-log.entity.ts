import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Maps fleet.vehicle_maintenance_logs (added in migration 0021) — an
 * append-only history of odometer/fuel entries a Branch Manager logs against a
 * vehicle (story BM-US-09). Rows are never updated or deleted, mirroring
 * ServiceRequestStatusHistory's audit-trail convention.
 */
@Entity({ schema: 'fleet', name: 'vehicle_maintenance_logs' })
export class VehicleMaintenanceLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'vehicle_id', type: 'uuid' })
  vehicleId!: string;

  /** Denormalized branch scope so the log can be branch-filtered without a
   * join (tenancy handle, AGENTS.md §5). */
  @Column({ name: 'branch_id', type: 'uuid' })
  branchId!: string;

  @Column({ name: 'odometer_km', type: 'int' })
  odometerKm!: number;

  @Column({ name: 'fuel_liters', type: 'numeric', nullable: true })
  fuelLiters!: number | null;

  /** The Branch Manager (auth user id) who logged this entry. */
  @Column({ name: 'logged_by', type: 'uuid' })
  loggedBy!: string;

  @Column({ name: 'logged_at', type: 'timestamptz' })
  loggedAt!: Date;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
