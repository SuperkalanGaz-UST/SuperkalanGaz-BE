import { NestFactory } from '@nestjs/core';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Repository } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AppModule } from '../app.module';
import { KnownStoreLocation } from '../reference/known-store-location.entity';

/** Shape of each record in known_store_locations.seed.json (captured snapshot). */
interface SeedRecord {
  name: string;
  full_address: string;
  province: string | null;
  city: string | null;
}

/**
 * Seeds core.known_store_locations from the captured snapshot JSON.
 *
 * IDEMPOTENT: the upsert key is full_address. Re-running never creates
 * duplicates — existing rows are updated in place, never deleted. Input is
 * de-duplicated by full_address first (keeping the first occurrence), because
 * the raw capture contains exactly one exact-address duplicate. Names are NOT a
 * key: "LAGUNA PREMIUM GAS" and "PETERPAN GAS" each legitimately appear twice
 * with different addresses and must both survive.
 *
 * Run standalone (no HTTP server) via: npm run seed:store-locations
 */
async function run(): Promise<void> {
  // Read from the source tree relative to the repo root (npm scripts run from
  // there), so it works whether invoked from src or a compiled dist build —
  // the JSON is not emitted into dist.
  const seedPath = join(
    process.cwd(),
    'src',
    'seeds',
    'known_store_locations.seed.json',
  );
  const records: SeedRecord[] = JSON.parse(readFileSync(seedPath, 'utf8'));

  // De-duplicate by full_address, keeping the first occurrence. Warn (don't
  // fail) on each dropped exact-address duplicate so the collapse is visible.
  const seen = new Set<string>();
  const unique: SeedRecord[] = [];
  let skipped = 0;
  for (const record of records) {
    const key = record.full_address;
    if (seen.has(key)) {
      skipped++;
      console.warn(
        `[seed] skipping duplicate full_address: "${record.full_address}" ` +
          `(name: "${record.name}") — collapsed to the first occurrence`,
      );
      continue;
    }
    seen.add(key);
    unique.push(record);
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    // Quiet the Nest bootstrap logs so the seed summary stands out.
    logger: ['warn', 'error'],
  });

  try {
    const repo = app.get<Repository<KnownStoreLocation>>(
      getRepositoryToken(KnownStoreLocation),
    );

    let inserted = 0;
    let updated = 0;

    for (const record of unique) {
      const existing = await repo.findOne({
        where: { fullAddress: record.full_address },
      });
      const now = new Date();

      if (existing) {
        // Update mutable fields; never touch is_active (a manual retire must
        // survive a re-seed) and never delete.
        existing.name = record.name;
        existing.province = record.province;
        existing.city = record.city;
        existing.updatedAt = now;
        await repo.save(existing);
        updated++;
      } else {
        await repo.save(
          repo.create({
            name: record.name,
            fullAddress: record.full_address,
            province: record.province,
            city: record.city,
            isActive: true,
            createdAt: now,
            updatedAt: now,
          }),
        );
        inserted++;
      }
    }

    console.log(
      `[seed] known_store_locations — inserted: ${inserted}, ` +
        `updated: ${updated}, skipped (duplicate full_address): ${skipped}`,
    );
  } finally {
    await app.close();
  }
}

run().catch((err) => {
  console.error('[seed] failed:', err);
  process.exit(1);
});
