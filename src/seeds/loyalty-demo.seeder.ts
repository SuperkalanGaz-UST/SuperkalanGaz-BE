import { NestFactory } from '@nestjs/core';
import { IsNull, Repository } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AppModule } from '../app.module';
import { Branch } from '../branches/branch.entity';
import { Customer } from '../cim/customer.entity';
import { CatalogItem } from '../loyalty/catalog-item.entity';
import { CommercialLoyaltyAccount } from '../loyalty/commercial-loyalty-account.entity';
import { HouseholdLoyaltyAccount } from '../loyalty/household-loyalty-account.entity';
import { Redemption } from '../loyalty/redemption.entity';

/** The household reward catalog planted for the demo branch. Keyed by name within
 * the branch (name is the idempotency handle — re-running updates in place). */
const CATALOG: { name: string; description: string; pointsCost: number; stockQty: number }[] = [
  { name: 'BBQ Grill Lighter', description: 'Refillable long-neck lighter', pointsCost: 150, stockQty: 25 },
  { name: '₱100 Refill Voucher', description: 'Discount on next cylinder refill', pointsCost: 300, stockQty: 40 },
  { name: 'Gas Stove Cleaning Kit', description: 'Brush + degreaser set', pointsCost: 500, stockQty: 10 },
];

/** Starting balance for the demo household account — enough to cover any single
 * catalog item so the approve flow is demoable end to end. */
const DEMO_POINTS_BALANCE = 500;

/** Demo commercial "30+1" account state: one earned-but-unredeemed free cylinder
 * (completed_cycles) and partway through the next cycle (current_cycle_count, 0–30)
 * — enough to approve one free-cylinder redemption end to end. */
const DEMO_COMPLETED_CYCLES = 1;
const DEMO_CURRENT_CYCLE = 12;

/** A demo household customer, planted only when the target branch has none so the
 * redemption flow has someone to redeem against. Keyed by contact_number (a valid
 * PH E.164 mobile per §16) for idempotency. */
const DEMO_CUSTOMER = {
  name: 'Demo Household (Loyalty)',
  contactNumber: '+639170000001',
  deliveryAddress: 'Demo Address — loyalty seed',
};

/**
 * Seeds BOTH loyalty tracks for a demo (BM-US-03): the household track (a small
 * reward catalog, one funded account, one PENDING points redemption) and the
 * commercial "30+1" track (an account with one earned free cylinder + one PENDING
 * free-cylinder redemption), so both Branch Manager approval queues are non-empty
 * on first load.
 *
 * IDEMPOTENT. Re-running never duplicates:
 *  - catalog items are keyed by (branch_id, name) — updated in place, never dropped;
 *  - the household account is keyed by (customer_id, branch_id) — created only if
 *    absent, and its balance is TOPPED UP TO (not reset — a spent-down demo is left
 *    alone unless it fell below) the demo minimum;
 *  - the pending redemption is created only if this customer has none pending.
 *
 * It targets the first active core.branches row that has at least one live
 * customer. If no such branch/customer exists it seeds the catalog only and warns
 * (nothing to redeem against yet).
 *
 * Run standalone (no HTTP server): npm run seed:loyalty-demo
 */
async function run(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['warn', 'error'],
  });

  try {
    const branches = app.get<Repository<Branch>>(getRepositoryToken(Branch));
    const customers = app.get<Repository<Customer>>(getRepositoryToken(Customer));
    const catalog = app.get<Repository<CatalogItem>>(getRepositoryToken(CatalogItem));
    const accounts = app.get<Repository<HouseholdLoyaltyAccount>>(
      getRepositoryToken(HouseholdLoyaltyAccount),
    );
    const commercialAccounts = app.get<Repository<CommercialLoyaltyAccount>>(
      getRepositoryToken(CommercialLoyaltyAccount),
    );
    const redemptions = app.get<Repository<Redemption>>(getRepositoryToken(Redemption));

    // Pick a demo branch: the first active branch that has a live customer to
    // redeem against. Fall back to any active branch for catalog-only seeding.
    const activeBranches = await branches.find({
      where: { status: 'active' },
      order: { name: 'ASC' },
    });
    if (activeBranches.length === 0) {
      console.warn('[seed] no active branch found — nothing seeded');
      return;
    }

    let branch = activeBranches[0];
    let customer: Customer | null = null;
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

    const now = new Date();

    // No live customer anywhere yet (fresh DB) — plant a demo household customer
    // in the target branch so there is someone to redeem against. Idempotent on
    // contact_number: a re-run reuses the same profile rather than duplicating.
    if (!customer) {
      customer = await customers.findOne({
        where: { contactNumber: DEMO_CUSTOMER.contactNumber, deletedAt: IsNull() },
      });
      if (!customer) {
        customer = await customers.save(
          customers.create({
            branchId: branch.id,
            name: DEMO_CUSTOMER.name,
            contactNumber: DEMO_CUSTOMER.contactNumber,
            deliveryAddress: DEMO_CUSTOMER.deliveryAddress,
            registrationSource: 'staff-created',
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
          }),
        );
      } else {
        // Reuse the existing demo profile; align the working branch to it so the
        // account + redemption below are consistent with the catalog we seed.
        branch = activeBranches.find((b) => b.id === customer!.branchId) ?? branch;
      }
    }

    // --- Catalog: upsert by (branch_id, name) ---
    let catInserted = 0;
    let catUpdated = 0;
    const seededItems: CatalogItem[] = [];
    for (const item of CATALOG) {
      const existing = await catalog.findOne({
        where: { branchId: branch.id, name: item.name },
      });
      if (existing) {
        existing.description = item.description;
        existing.pointsCost = item.pointsCost;
        // Only lift stock back up to the demo level if it dropped below — don't
        // clobber a deliberately spent-down demo.
        if (existing.stockQty < item.stockQty) existing.stockQty = item.stockQty;
        existing.isActive = true;
        existing.updatedAt = now;
        seededItems.push(await catalog.save(existing));
        catUpdated++;
      } else {
        seededItems.push(
          await catalog.save(
            catalog.create({
              branchId: branch.id,
              name: item.name,
              description: item.description,
              pointsCost: item.pointsCost,
              stockQty: item.stockQty,
              isActive: true,
              createdBy: null,
              createdAt: now,
              updatedAt: now,
            }),
          ),
        );
        catInserted++;
      }
    }

    if (!customer) {
      console.warn(
        `[seed] loyalty-demo — catalog seeded for branch "${branch.name}" ` +
          `(inserted: ${catInserted}, updated: ${catUpdated}); ` +
          'no live customer in any active branch, so no account/redemption seeded',
      );
      return;
    }

    // --- Household account: create if absent, top up to the demo minimum ---
    let account = await accounts.findOne({
      where: { customerId: customer.id, branchId: branch.id },
    });
    if (!account) {
      account = await accounts.save(
        accounts.create({
          customerId: customer.id,
          branchId: branch.id,
          pointsBalance: DEMO_POINTS_BALANCE,
          createdAt: now,
          updatedAt: now,
        }),
      );
    } else if (account.pointsBalance < DEMO_POINTS_BALANCE) {
      account.pointsBalance = DEMO_POINTS_BALANCE;
      account.updatedAt = now;
      account = await accounts.save(account);
    }

    // --- One PENDING redemption, only if this customer has none pending ---
    const alreadyPending = await redemptions.findOne({
      where: {
        customerId: customer.id,
        branchId: branch.id,
        track: 'household_points',
        status: 'pending',
      },
    });
    let redemptionNote: string;
    if (alreadyPending) {
      redemptionNote = 'pending redemption already present (left as is)';
    } else {
      // Redeem against an affordable item so approval succeeds in the demo.
      const affordable =
        seededItems
          .filter((i) => i.pointsCost <= account!.pointsBalance && i.stockQty > 0)
          .sort((a, b) => a.pointsCost - b.pointsCost)[0] ?? seededItems[0];
      await redemptions.save(
        redemptions.create({
          branchId: branch.id,
          customerId: customer.id,
          track: 'household_points',
          catalogItemId: affordable.id,
          rewardDescription: affordable.name,
          pointsSpent: affordable.pointsCost,
          status: 'pending',
          requestedAt: now,
          approvedBy: null,
          approvedAt: null,
          rejectedReason: null,
          fulfilledAt: null,
          createdAt: now,
          updatedAt: now,
        }),
      );
      redemptionNote = `pending redemption created for "${affordable.name}" (${affordable.pointsCost} pts)`;
    }

    // --- Commercial "30+1" track: account with one earned free cylinder + a
    //     pending free-cylinder redemption, so the commercial queue is demoable. ---
    let commercial = await commercialAccounts.findOne({
      where: { customerId: customer.id, branchId: branch.id },
    });
    if (!commercial) {
      commercial = await commercialAccounts.save(
        commercialAccounts.create({
          customerId: customer.id,
          branchId: branch.id,
          currentCycleCount: DEMO_CURRENT_CYCLE,
          completedCycles: DEMO_COMPLETED_CYCLES,
          createdAt: now,
          updatedAt: now,
        }),
      );
    } else if (commercial.completedCycles < DEMO_COMPLETED_CYCLES) {
      // Top up to at least one redeemable cycle (don't clobber a spent-down demo).
      commercial.completedCycles = DEMO_COMPLETED_CYCLES;
      commercial.updatedAt = now;
      commercial = await commercialAccounts.save(commercial);
    }

    const commercialPending = await redemptions.findOne({
      where: {
        customerId: customer.id,
        branchId: branch.id,
        track: 'commercial_30plus1',
        status: 'pending',
      },
    });
    let commercialNote: string;
    if (commercialPending) {
      commercialNote = 'commercial pending redemption already present (left as is)';
    } else {
      await redemptions.save(
        redemptions.create({
          branchId: branch.id,
          customerId: customer.id,
          track: 'commercial_30plus1',
          catalogItemId: null,
          rewardDescription: 'Free cylinder (30+1)',
          pointsSpent: null,
          status: 'pending',
          requestedAt: now,
          approvedBy: null,
          approvedAt: null,
          rejectedReason: null,
          fulfilledAt: null,
          createdAt: now,
          updatedAt: now,
        }),
      );
      commercialNote = 'commercial pending free-cylinder redemption created';
    }

    console.log(
      `[seed] loyalty-demo — branch "${branch.name}", customer "${customer.name}"; ` +
        `catalog inserted: ${catInserted}, updated: ${catUpdated}; ` +
        `account balance: ${account.pointsBalance} pts; ${redemptionNote}; ` +
        `commercial cycles: ${commercial.completedCycles} completed / ${commercial.currentCycleCount} in progress; ${commercialNote}`,
    );
  } finally {
    await app.close();
  }
}

run().catch((err) => {
  console.error('[seed] failed:', err);
  process.exit(1);
});
