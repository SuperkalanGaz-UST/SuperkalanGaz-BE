import { NestFactory } from '@nestjs/core';
import { IsNull, Repository } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AppModule } from '../app.module';
import { Branch } from '../branches/branch.entity';
import { Customer } from '../cim/customer.entity';
import { Rating } from '../csat/rating.entity';
import { Incident } from '../csat/incident.entity';
import { ServiceRequest } from '../service-requests/service-request.entity';

/**
 * Preferred demo branch: the login the developer/reviewer actually has access
 * to (Pedro Cruz / manager@superkalan.com is scoped to this branch). Falls back
 * to "first active branch with a live customer" if this one doesn't exist yet —
 * see the branch-selection logic below.
 */
const PREFERRED_BRANCH_NAME = 'Amadeo, Cavite';

/**
 * The demo feedback set. A rating only makes sense against a COMPLETED delivery,
 * so each entry seeds a Delivered service request and the customer's rating of
 * it. Deliberately spans the low-CSAT band (1–3 stars, what the Branch Manager
 * queue surfaces) plus one 5-star row, so the queue's filtering is visibly doing
 * something rather than just listing everything.
 */
const FEEDBACK: {
  stars: number;
  comment: string;
  cylinderSize: string;
  quantity: number;
  daysAgo: number;
}[] = [
  { stars: 1, comment: 'Sobrang tagal ng delivery, 4 hours late.', cylinderSize: '11kg', quantity: 1, daysAgo: 1 },
  { stars: 2, comment: 'Mali ang size na dinala, nagpalit pa.', cylinderSize: '11kg', quantity: 2, daysAgo: 2 },
  { stars: 3, comment: 'Okay naman pero hindi tumawag ang rider bago dumating.', cylinderSize: '2.7kg', quantity: 1, daysAgo: 3 },
  { stars: 5, comment: 'Mabilis at maayos, salamat!', cylinderSize: '11kg', quantity: 1, daysAgo: 4 },
];

/** Planted only when the target branch has no customer to rate against. Keyed by
 * contact_number (valid PH E.164 per §16) for idempotency. */
const DEMO_CUSTOMER = {
  name: 'Demo Customer (CSAT)',
  contactNumber: '+639170000002',
  deliveryAddress: 'Demo Address — CSAT seed',
};

/**
 * The demo incident set (journey BM-US-04): a lost/undelivered cylinder
 * complaint logged against its OWN Delivered service request — deliberately
 * separate from the FEEDBACK ratings above so the Ratings and Incidents views
 * each show their own clean, non-overlapping demo story. Left Open and
 * un-escalated so the Branch Manager can click through Escalate live.
 */
const INCIDENTS: {
  category: 'lost_cylinder';
  description: string;
  cylinderSize: string;
  quantity: number;
  daysAgo: number;
}[] = [
  {
    category: 'lost_cylinder',
    description: 'Customer called saying the cylinder never arrived even though the rider marked the order as delivered. Following up with the rider.',
    cylinderSize: '11kg',
    quantity: 1,
    daysAgo: 1,
  },
];

/**
 * Seeds demo data for both CSAT journeys:
 *  - BM-US-08 (low-CSAT follow-up): a handful of Delivered service requests and
 *    the customer ratings of them, including three in the low-CSAT band (1–3
 *    stars) left Open so the Branch Manager's Ratings queue is non-empty.
 *  - BM-US-04 (lost/undelivered cylinder): one complaint logged against its own
 *    fresh Delivered service request (flipped to 'Under Review', mirroring the
 *    real API), left Open and un-escalated so the Branch Manager's Incidents
 *    queue is demoable and Escalate can be clicked live.
 *
 * Ratings are normally submitted by customers on mobile — this seeder stands in
 * for that client, which does not exist yet. Incidents are normally logged by
 * the Branch Manager via the Orders screen's "Log Complaint" action — this
 * seeder stands in for that click so the Incidents queue isn't empty on first
 * load.
 *
 * IDEMPOTENT. Re-running never duplicates: each rating is keyed by (branch,
 * customer, stars, comment); each incident is keyed by (branch, customer,
 * description). An existing row is left exactly as-is, including any
 * resolution/escalation a BM already recorded against it.
 *
 * Targets PREFERRED_BRANCH_NAME ("Amadeo, Cavite" — the branch the developer
 * actually has a working login for), falling back to the first active branch
 * with a live customer. Run standalone (no HTTP server): npm run seed:csat-demo
 */
async function run(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['warn', 'error'],
  });

  try {
    const branches = app.get<Repository<Branch>>(getRepositoryToken(Branch));
    const customers = app.get<Repository<Customer>>(getRepositoryToken(Customer));
    const ratings = app.get<Repository<Rating>>(getRepositoryToken(Rating));
    const incidents = app.get<Repository<Incident>>(getRepositoryToken(Incident));
    const serviceRequests = app.get<Repository<ServiceRequest>>(
      getRepositoryToken(ServiceRequest),
    );

    const activeBranches = await branches.find({
      where: { status: 'active' },
      order: { name: 'ASC' },
    });
    if (activeBranches.length === 0) {
      console.warn('[seed] csat-demo — no active branch found; nothing seeded');
      return;
    }

    // Prefer the branch the developer/reviewer can actually log into
    // (PREFERRED_BRANCH_NAME); otherwise fall back to the first active branch
    // that already has a live customer, so the demo data hangs off a real
    // profile rather than a synthetic one.
    let branch = activeBranches.find((b) => b.name === PREFERRED_BRANCH_NAME) ?? activeBranches[0];
    let customer: Customer | null = await customers.findOne({
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

    const now = new Date();

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
      }
    }

    let created = 0;
    let skipped = 0;

    for (const f of FEEDBACK) {
      // Idempotency key: this customer + this exact feedback in this branch.
      const existing = await ratings.findOne({
        where: {
          branchId: branch.id,
          customerId: customer.id,
          stars: f.stars,
          comment: f.comment,
        },
      });
      if (existing) {
        skipped++;
        continue;
      }

      // A rating needs a completed delivery to point at — seed the full chain so
      // the queue's "open the associated service request" step (BM-039) has real
      // data with all four SLA timestamps populated.
      const requestedAt = new Date(now.getTime() - f.daysAgo * 24 * 60 * 60 * 1000);
      const dispatchedAt = new Date(requestedAt.getTime() + 20 * 60 * 1000);
      const inTransitAt = new Date(requestedAt.getTime() + 35 * 60 * 1000);
      const deliveredAt = new Date(requestedAt.getTime() + 90 * 60 * 1000);

      const sr = await serviceRequests.save(
        serviceRequests.create({
          branchId: branch.id,
          orderSource: 'Walk-in/Phone',
          status: 'Delivered',
          customerId: customer.id,
          customerName: customer.name,
          customerContact: customer.contactNumber,
          deliveryAddress: customer.deliveryAddress,
          cylinderSize: f.cylinderSize,
          quantity: f.quantity,
          unitPrice: null,
          totalAmount: null,
          specialInstructions: null,
          riderId: null,
          requestedAt,
          dispatchedAt,
          inTransitAt,
          deliveredAt,
          createdAt: requestedAt,
          updatedAt: deliveredAt,
          deletedAt: null,
        }),
      );

      // The customer's rating of that delivery, left Open for the BM to action.
      await ratings.save(
        ratings.create({
          branchId: branch.id,
          serviceRequestId: sr.id,
          customerId: customer.id,
          stars: f.stars,
          comment: f.comment,
          submittedAt: new Date(deliveredAt.getTime() + 30 * 60 * 1000),
          createdAt: new Date(deliveredAt.getTime() + 30 * 60 * 1000),
          resolutionStatus: 'Open',
          resolutionNote: null,
          resolvedBy: null,
          resolvedAt: null,
        }),
      );
      created++;
    }

    const lowOpen = await ratings.count({
      where: { branchId: branch.id, resolutionStatus: 'Open' },
    });

    // --- Incidents (journey BM-US-04): each on its OWN fresh Delivered service
    //     request, kept separate from the rating-linked ones above. ---
    let incidentsCreated = 0;
    let incidentsSkipped = 0;

    for (const inc of INCIDENTS) {
      // Idempotency key: this customer + this exact description in this branch.
      const existing = await incidents.findOne({
        where: { branchId: branch.id, customerId: customer.id, description: inc.description },
      });
      if (existing) {
        incidentsSkipped++;
        continue;
      }

      const requestedAt = new Date(now.getTime() - inc.daysAgo * 24 * 60 * 60 * 1000);
      const dispatchedAt = new Date(requestedAt.getTime() + 20 * 60 * 1000);
      const inTransitAt = new Date(requestedAt.getTime() + 35 * 60 * 1000);
      const deliveredAt = new Date(requestedAt.getTime() + 90 * 60 * 1000);

      const sr = await serviceRequests.save(
        serviceRequests.create({
          branchId: branch.id,
          orderSource: 'Walk-in/Phone',
          status: 'Delivered',
          customerId: customer.id,
          customerName: customer.name,
          customerContact: customer.contactNumber,
          deliveryAddress: customer.deliveryAddress,
          cylinderSize: inc.cylinderSize,
          quantity: inc.quantity,
          unitPrice: null,
          totalAmount: null,
          specialInstructions: null,
          riderId: null,
          requestedAt,
          dispatchedAt,
          inTransitAt,
          deliveredAt,
          createdAt: requestedAt,
          updatedAt: deliveredAt,
          deletedAt: null,
        }),
      );

      await incidents.save(
        incidents.create({
          branchId: branch.id,
          customerId: customer.id,
          serviceRequestId: sr.id,
          category: inc.category,
          description: inc.description,
          status: 'open',
          priority: 'medium',
          reportedAt: new Date(deliveredAt.getTime() + 45 * 60 * 1000),
          firstResponseAt: null,
          resolvedAt: null,
          assignedTo: null,
          resolutionNote: null,
          escalated: false,
          escalatedAt: null,
          createdAt: new Date(deliveredAt.getTime() + 45 * 60 * 1000),
          updatedAt: new Date(deliveredAt.getTime() + 45 * 60 * 1000),
        }),
      );
      // Complaint logging flips the SR to Under Review (story BM-021) — the seed
      // mirrors the real API's side effect so the Orders screen shows the same
      // state a live BM-created complaint would leave behind.
      sr.status = 'Under Review';
      sr.updatedAt = new Date(deliveredAt.getTime() + 45 * 60 * 1000);
      await serviceRequests.save(sr);
      incidentsCreated++;
    }

    console.log(
      `[seed] csat-demo — branch "${branch.name}", customer "${customer.name}"; ` +
        `ratings created: ${created}, already present: ${skipped}; ` +
        `open ratings in branch: ${lowOpen}; ` +
        `incidents created: ${incidentsCreated}, already present: ${incidentsSkipped}`,
    );
  } finally {
    await app.close();
  }
}

run().catch((err) => {
  console.error('[seed] csat-demo failed:', err);
  process.exit(1);
});
