import { NestFactory } from '@nestjs/core';
import { Repository } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AppModule } from '../app.module';
import { Branch } from '../branches/branch.entity';
import { Rider } from '../fleet/rider.entity';
import { Vehicle } from '../fleet/vehicle.entity';

/** Same convention as csat-demo.seeder.ts / sla-demo.seeder.ts. */
const PREFERRED_BRANCH_NAME = 'Amadeo, Cavite';

/**
 * Seeds fleet.vehicles rows for story BM-US-09 (Log Vehicle Mileage and
 * Maintenance). fleet.vehicles already exists in the shared schema but starts
 * empty — there is no vehicle-CRUD UI in this slice (mirrors how riders are
 * seeded manually, per rider.entity.ts's own doc comment).
 *
 * One vehicle is seeded already past the branch's maintenance_threshold_km so
 * the Fleet Roster's "PMS Due / Overdue" state is demoable on first load,
 * without the reviewer having to log mileage first; the other is well within
 * threshold so the healthy state is visible too.
 *
 * IDEMPOTENT. Keyed on (branch_id, plate_number) — an existing row is left
 * exactly as-is (including any mileage a BM has since logged against it).
 * Run standalone (no HTTP server): npm run seed:fleet-vehicles-demo
 */
async function run(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['warn', 'error'],
  });

  try {
    const branches = app.get<Repository<Branch>>(getRepositoryToken(Branch));
    const riders = app.get<Repository<Rider>>(getRepositoryToken(Rider));
    const vehicles = app.get<Repository<Vehicle>>(getRepositoryToken(Vehicle));

    const branch = await branches.findOne({ where: { name: PREFERRED_BRANCH_NAME } });
    if (!branch) {
      console.log(`No branch named "${PREFERRED_BRANCH_NAME}" found — nothing to seed.`);
      return;
    }

    const branchRiders = await riders.find({ where: { branchId: branch.id } });
    if (branchRiders.length === 0) {
      console.log(`Branch "${branch.name}" has no riders yet — nothing to attach vehicles to.`);
      return;
    }

    // The over-threshold vehicle goes to a currently-Available rider so the
    // Maintenance Due exclusion (BM-045) is visibly checkable in the dispatch
    // dropdown right away, rather than landing on a rider who's mid-delivery.
    const overThresholdRider =
      branchRiders.find((r) => r.status === 'Available') ?? branchRiders[0];
    const healthyRider = branchRiders.find((r) => r.id !== overThresholdRider.id);

    const now = new Date();
    const plan: {
      rider: Rider | undefined;
      vehicleType: string;
      currentOdometerKm: number;
      lastPmsOdometerKm: number;
    }[] = [
      {
        // Deliberately past threshold (3000km default) — demoes BM-044/045
        // (Maintenance Due flag + dispatch exclusion) without any manual steps.
        rider: overThresholdRider,
        vehicleType: 'motorcycle',
        currentOdometerKm: 14500,
        lastPmsOdometerKm: 11200,
      },
      {
        rider: healthyRider,
        vehicleType: 'motorcycle',
        currentOdometerKm: 8900,
        lastPmsOdometerKm: 6800,
      },
    ];

    for (const { rider, vehicleType, currentOdometerKm, lastPmsOdometerKm } of plan) {
      if (!rider) continue;

      const existing = await vehicles.findOne({
        where: { branchId: branch.id, plateNumber: rider.plate },
      });
      if (existing) {
        console.log(`Vehicle ${rider.plate} already seeded — leaving as-is.`);
        continue;
      }

      const threshold = branch.maintenanceThresholdKm;
      const dueForMaintenance = currentOdometerKm - lastPmsOdometerKm >= threshold;

      const vehicle = vehicles.create({
        branchId: branch.id,
        plateNumber: rider.plate,
        vehicleType,
        assignedRiderId: rider.id,
        status: dueForMaintenance ? 'maintenance' : 'active',
        currentOdometerKm,
        lastPmsOdometerKm,
        createdAt: now,
        updatedAt: now,
      });
      await vehicles.save(vehicle);
      console.log(`Seeded vehicle ${rider.plate} for rider ${rider.name} — status=${vehicle.status}`);

      if (dueForMaintenance) {
        await riders.update(
          { id: rider.id, status: 'Available' },
          { status: 'Maintenance Due', updatedAt: now },
        );
        console.log(`Rider ${rider.name} flagged Maintenance Due (vehicle over threshold).`);
      }
    }
  } finally {
    await app.close();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
