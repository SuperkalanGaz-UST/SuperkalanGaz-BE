import { NestFactory } from '@nestjs/core';
import { DataSource, IsNull, Repository } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AppModule } from '../app.module';
import { Branch } from '../branches/branch.entity';
import { Customer } from '../cim/customer.entity';
import { ServiceRequest } from '../service-requests/service-request.entity';
import { SlaConfiguration } from '../service-requests/sla-configuration.entity';

/** Preferred demo branch — same convention as csat-demo.seeder.ts. */
const PREFERRED_BRANCH_NAME = 'Amadeo, Cavite';

/** The Franchise Administrator account that "set" these demo thresholds — SLA
 * configuration is FA-owned (BM-008's own framing), so the seed's set_by is a
 * real FA account, not a placeholder. Looked up by email (auth.users has no
 * TypeORM entity in this codebase — no module owns Supabase Auth as a table). */
const FA_EMAIL = 'admin@superkalan.com';

/**
 * Global (branch_id NULL) default SLA thresholds — every branch without its
 * own override inherits these. Deliberately set ABOVE this project's other
 * seeders' typical delivery timing (dispatch ~20min after request, delivery
 * ~90min after request) so THOSE seeded orders don't retroactively show as
 * breached; the dedicated delayed demo order below is the one built to trip
 * the request_to_dispatch threshold live.
 */
const THRESHOLDS: { segment: SlaConfiguration['segment']; minutes: number }[] = [
  { segment: 'request_to_dispatch', minutes: 30 },
  { segment: 'dispatch_to_in_transit', minutes: 20 },
  { segment: 'in_transit_to_delivery', minutes: 40 },
  { segment: 'end_to_end', minutes: 120 },
];

/**
 * Seeds demo data for the delayed-delivery journey (BM-US-02):
 *  - four GLOBAL SLA threshold rows (core.sla_configurations), one per segment
 *    plus the end_to_end fallback, so every branch has a working threshold
 *    without per-branch seeding — configuring these is FA territory (BM-008),
 *    this seeder just stands in for that one-time setup so the feature is
 *    demoable;
 *  - one Pending request whose requested_at is set far enough in the past to
 *    already exceed the request_to_dispatch threshold, so the Branch
 *    Manager's queue shows a live "at risk" flag (BM-008) on first load
 *    without waiting 30 real minutes.
 *
 * IDEMPOTENT. Re-running never duplicates: the threshold rows are keyed by
 * (segment, order_source='all', branch_id IS NULL) — an existing one is left
 * exactly as-is (including if a BM/FA already tuned it); the demo order is
 * keyed by (branch, customer, a fixed marker in special_instructions).
 *
 * Targets PREFERRED_BRANCH_NAME for the demo order (falling back to the first
 * active branch with a live customer); the threshold rows are branch-agnostic.
 * Run standalone (no HTTP server): npm run seed:sla-demo
 */
async function run(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['warn', 'error'],
  });

  try {
    const branches = app.get<Repository<Branch>>(getRepositoryToken(Branch));
    const customers = app.get<Repository<Customer>>(getRepositoryToken(Customer));
    const slaConfigurations = app.get<Repository<SlaConfiguration>>(
      getRepositoryToken(SlaConfiguration),
    );
    const serviceRequests = app.get<Repository<ServiceRequest>>(
      getRepositoryToken(ServiceRequest),
    );
    const dataSource = app.get(DataSource);

    // auth.users has no TypeORM entity in this codebase (Supabase Auth owns
    // that table) — a raw query is the established way to reach it (mirrors
    // the LPM/CSAT services' raw cim.customers lookups by table name).
    const faRows: { id: string }[] = await dataSource.query(
      'SELECT id FROM auth.users WHERE email = $1 LIMIT 1',
      [FA_EMAIL],
    );
    if (faRows.length === 0) {
      console.warn(
        `[seed] sla-demo — no auth user found for ${FA_EMAIL}; skipping threshold seed`,
      );
    } else {
      const setBy = faRows[0].id;
      const now = new Date();
      let thresholdsCreated = 0;
      let thresholdsSkipped = 0;

      for (const t of THRESHOLDS) {
        const existing = await slaConfigurations.findOne({
          where: { branchId: IsNull(), segment: t.segment, orderSource: 'all' },
        });
        if (existing) {
          thresholdsSkipped++;
          continue;
        }
        await slaConfigurations.save(
          slaConfigurations.create({
            branchId: null,
            segment: t.segment,
            orderSource: 'all',
            thresholdMinutes: t.minutes,
            setBy,
            effectiveFrom: now,
            isActive: true,
            createdAt: now,
            updatedAt: now,
          }),
        );
        thresholdsCreated++;
      }
      console.log(
        `[seed] sla-demo — thresholds created: ${thresholdsCreated}, already present: ${thresholdsSkipped}`,
      );
    }

    // --- Demo delayed order (BM-008 live "at risk" flag) ---
    const activeBranches = await branches.find({
      where: { status: 'active' },
      order: { name: 'ASC' },
    });
    if (activeBranches.length === 0) {
      console.warn('[seed] sla-demo — no active branch found; no demo order seeded');
      return;
    }
    let branch = activeBranches.find((b) => b.name === PREFERRED_BRANCH_NAME) ?? activeBranches[0];
    let customer = await customers.findOne({
      where: { branchId: branch.id, deletedAt: IsNull() },
      order: { createdAt: 'ASC' },
    });
    if (!customer) {
      for (const b of activeBranches) {
        const c = await customers.findOne({
          where: { branchId: b.id, deletedAt: IsNull() },
          order: { createdAt: 'ASC' },
        });
        if (c) {
          branch = b;
          customer = c;
          break;
        }
      }
    }
    if (!customer) {
      console.warn('[seed] sla-demo — no branch has a live customer; no demo order seeded');
      return;
    }

    // Idempotency: at most one seeded Pending demo order per customer — a real
    // BM dispatching/cancelling it is expected to make it disappear from here,
    // same as any other seeded row once acted upon.
    const existingOrder = await serviceRequests.findOne({
      where: { branchId: branch.id, customerId: customer.id, status: 'Pending' },
    });
    if (existingOrder) {
      console.log(
        `[seed] sla-demo — a Pending demo order already exists in "${branch.name}" (${existingOrder.id})`,
      );
      return;
    }

    // 45 minutes ago — safely past the 30-minute request_to_dispatch threshold,
    // so the queue flags it as at-risk immediately, with no waiting required.
    const requestedAt = new Date(Date.now() - 45 * 60 * 1000);
    const order = await serviceRequests.save(
      serviceRequests.create({
        branchId: branch.id,
        orderSource: 'Walk-in/Phone',
        status: 'Pending',
        customerId: customer.id,
        customerName: customer.name,
        customerContact: customer.contactNumber,
        deliveryAddress: customer.deliveryAddress,
        cylinderSize: '11kg',
        quantity: 1,
        unitPrice: null,
        totalAmount: null,
        specialInstructions: 'Please call upon arrival — gate code 1234.',
        riderId: null,
        requestedAt,
        dispatchedAt: null,
        inTransitAt: null,
        deliveredAt: null,
        createdAt: requestedAt,
        updatedAt: requestedAt,
        deletedAt: null,
      }),
    );
    console.log(
      `[seed] sla-demo — delayed demo order created in "${branch.name}" for "${customer.name}" (${order.id}), requested 45 min ago`,
    );
  } finally {
    await app.close();
  }
}

run().catch((err) => {
  console.error('[seed] sla-demo failed:', err);
  process.exit(1);
});
