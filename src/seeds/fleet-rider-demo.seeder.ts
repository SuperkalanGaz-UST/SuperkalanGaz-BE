import { NestFactory } from '@nestjs/core';
import { Repository } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AppModule } from '../app.module';
import { Branch } from '../branches/branch.entity';
import { Rider } from '../fleet/rider.entity';

const PREFERRED_BRANCH_NAME = 'Amadeo, Cavite';

/**
 * Seeds a fleet.riders row so the BM dispatch dropdown has at least one
 * Available rider to test the Assign & Dispatch flow.
 *
 * IDEMPOTENT — skips if the branch already has a rider with the same plate.
 * Run standalone (no HTTP server): npm run seed:fleet-rider-demo
 */
async function run(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['warn', 'error'],
  });

  try {
    const branches = app.get<Repository<Branch>>(getRepositoryToken(Branch));
    const riders = app.get<Repository<Rider>>(getRepositoryToken(Rider));

    const branch = await branches.findOne({ where: { name: PREFERRED_BRANCH_NAME } });
    if (!branch) {
      console.log(`No branch named "${PREFERRED_BRANCH_NAME}" found — nothing to seed.`);
      return;
    }

    const now = new Date();
    const riderData = {
      branchId: branch.id,
      name: 'Aljon Santos',
      plate: 'ABC-1234',
      status: 'Available' as const,
      createdAt: now,
      updatedAt: now,
    };

    const existing = await riders.findOne({
      where: { branchId: branch.id, plate: riderData.plate },
    });
    if (existing) {
      if (existing.status !== 'Available') {
        existing.status = 'Available';
        existing.updatedAt = now;
        await riders.save(existing);
        console.log(`Rider "${riderData.name}" (${riderData.plate}) status reset to Available (was ${existing.status}).`);
      } else {
        console.log(`Rider "${riderData.name}" (${riderData.plate}) already exists with status Available — skipping.`);
      }
      return;
    }

    const rider = riders.create(riderData);
    await riders.save(rider);
    console.log(`Seeded rider "${rider.name}" (${rider.plate}) in branch "${branch.name}" — status=${rider.status}`);
    console.log(`Rider ID: ${rider.id}`);
  } finally {
    await app.close();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
