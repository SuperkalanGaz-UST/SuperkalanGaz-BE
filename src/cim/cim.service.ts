import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { Principal } from '../auth/principal';
import { Customer } from './customer.entity';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { SearchCustomersQuery } from './dto/search-customers.query';

/** A matched customer plus their most recent order date (MAX requested_at across
 * their non-deleted Service Requests). The search query only returns customers
 * with an order in the same branch, so this is non-null for persisted results. */
export interface CustomerListItem {
  customer: Customer;
  lastOrderDate: Date | null;
}

/**
 * Customer Information Management (CIM module). This slice covers customer search
 * (autopopulate at intake) and inline registration, plus an internal lookup the
 * SRD service reuses to validate a customer when linking them onto a Service
 * Request. No edit/delete/merge and no GET /customers/:id — search covers
 * autopopulate (YAGNI, AGENTS.md §3.5).
 *
 * All scoping derives from the verified Principal, never from request input
 * (AGENTS.md §5). Isolation is enforced here in the application layer, not by the
 * DB — a missing branch filter is a cross-tenant leak.
 */
@Injectable()
export class CimService {
  constructor(
    @InjectRepository(Customer)
    private readonly customers: Repository<Customer>,
  ) {}

  /**
   * List / search the caller's branch(es) for customers who have at least one
   * linked, non-deleted Service Request in that same branch. This prevents a
   * profile created for another branch—or an abandoned inline registration—from
   * appearing in the caller's directory. Two modes on the same handler:
   *  - with a term (>= 2 chars, validated upstream): the intake autocomplete —
   *    name OR contact_number case-insensitive substring, capped at 20;
   *  - without a term: the CIM Customers directory (BM-031) — the whole branch,
   *    capped at 200 so it stays bounded.
   * Branch scope comes from the principal; request input can never widen it
   * (AGENTS.md §5).
   */
  async search(
    principal: Principal,
    query: SearchCustomersQuery,
  ): Promise<CustomerListItem[]> {
    const branchIds = this.requireBranches(principal);
    const term = query.search?.trim();

    const customerQuery = this.customers
      .createQueryBuilder('customer')
      .where('customer.branch_id IN (:...branchIds)', { branchIds })
      .andWhere('customer.deleted_at IS NULL')
      .andWhere(
        `EXISTS (
          SELECT 1
          FROM srd.service_requests service_request
          WHERE service_request.customer_id = customer.id
            AND service_request.branch_id = customer.branch_id
            AND service_request.deleted_at IS NULL
        )`,
      );

    if (term) {
      customerQuery.andWhere(
        '(customer.name ILIKE :term OR customer.contact_number ILIKE :term)',
        { term: `%${term}%` },
      );
    }

    const customers = await customerQuery
      .orderBy('customer.name', 'ASC')
      .take(term ? 20 : 200)
      .getMany();
    if (customers.length === 0) return [];

    const lastOrders = await this.lastOrderDates(
      customers.map((c) => c.id),
      branchIds,
    );
    return customers.map((customer) => ({
      customer,
      lastOrderDate: lastOrders.get(customer.id) ?? null,
    }));
  }

  /**
   * Register a customer inline during intake (stories BM-029/BM-030/BM-031). The
   * server owns branch_id (the caller's own branch) and registration_source
   * ('staff-created') — the client only supplies the three profile fields.
   */
  async create(principal: Principal, dto: CreateCustomerDto): Promise<Customer> {
    const branchId = this.requireBranch(principal);

    const now = new Date();
    const customer = this.customers.create({
      branchId,
      authUserId: null,
      name: dto.name.trim(),
      contactNumber: dto.contactNumber.trim(),
      deliveryAddress: dto.deliveryAddress.trim(),
      // BM-created profiles are always staff-created (story BM-031); the client
      // never gets to set this.
      registrationSource: 'staff-created',
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });

    return this.customers.save(customer);
  }

  /**
   * Materialize an authenticated mobile customer into the selected branch's
   * CIM directory when they place an order. Registration itself cannot create
   * this row because a mobile account is global and has no branch until an
   * order is addressed to one.
   *
   * The unique (branch_id, auth_user_id) index makes this an idempotent,
   * race-safe upsert. Only server-verified identity and the already-validated
   * order branch reach this method; neither value comes from an editable
   * customer profile field.
   */
  async upsertSelfRegisteredInBranch(input: {
    authUserId: string;
    branchId: string;
    name: string;
    contactNumber: string;
    deliveryAddress: string;
  }): Promise<Customer> {
    const now = new Date();
    await this.customers.upsert(
      {
        branchId: input.branchId,
        authUserId: input.authUserId,
        name: input.name.trim(),
        contactNumber: input.contactNumber.trim(),
        deliveryAddress: input.deliveryAddress.trim(),
        registrationSource: 'self-registered',
        // created_at is omitted so the DB default handles inserts and repeat
        // orders never rewrite the profile's original creation timestamp.
        updatedAt: now,
        deletedAt: null,
      },
      {
        conflictPaths: ['branchId', 'authUserId'],
        skipUpdateIfNoValuesChanged: true,
      },
    );

    return this.customers.findOneByOrFail({
      branchId: input.branchId,
      authUserId: input.authUserId,
      deletedAt: IsNull(),
    });
  }

  /** Resolve every live branch-owned CIM profile belonging to one authenticated
   * mobile customer. Used only for that customer's own order history. */
  async profileIdsForAuthUser(authUserId: string): Promise<string[]> {
    const profiles = await this.customers.find({
      where: { authUserId, deletedAt: IsNull() },
      select: { id: true },
      take: 200,
    });
    return profiles.map((profile) => profile.id);
  }

  /**
   * Internal lookup used by the SRD create flow to confirm a customer can be
   * linked onto a Service Request: the customer exists, is not soft-deleted, and
   * belongs to the SAME branch as the request. Returns null when any of those
   * fail — the caller turns that into a BadRequestException. Referential
   * integrity is checked here in the service layer; the schema has no FK
   * constraints by design (AGENTS.md §6). Mirrors FleetService.findAssignableRider.
   */
  async findInBranch(
    customerId: string,
    branchId: string,
  ): Promise<Customer | null> {
    return this.customers.findOne({
      where: { id: customerId, branchId, deletedAt: IsNull() },
    });
  }

  /**
   * Most-recent order date per customer: MAX(requested_at) over their
   * non-deleted Service Requests. Referenced by the fully-qualified table name
   * srd.service_requests (NOT the SRD entity) on purpose — the SRD module imports
   * CIM (for the customer link), so CIM must not import SRD back or the modules
   * would form a cycle. The soft-delete filter mirrors the SRD service. Customers
   * with no linked order are simply absent from the result (→ null); with the
   * link freshly added, that is every customer for now, which is expected.
   */
  private async lastOrderDates(
    customerIds: string[],
    branchIds: string[],
  ): Promise<Map<string, Date>> {
    const rows = await this.customers.manager
      .createQueryBuilder()
      .select('sr.customer_id', 'customer_id')
      .addSelect('MAX(sr.requested_at)', 'last_order_date')
      .from('srd.service_requests', 'sr')
      .where('sr.customer_id IN (:...customerIds)', { customerIds })
      .andWhere('sr.branch_id IN (:...branchIds)', { branchIds })
      .andWhere('sr.deleted_at IS NULL')
      .groupBy('sr.customer_id')
      .getRawMany<{ customer_id: string; last_order_date: Date }>();

    return new Map(rows.map((r) => [r.customer_id, r.last_order_date]));
  }

  /** The caller's active branch UUIDs; fails closed if they have none. */
  private requireBranches(principal: Principal): string[] {
    if (principal.branchIds.length === 0) {
      throw new ForbiddenException('Caller has no active branch');
    }
    return principal.branchIds;
  }

  /** The single branch a new customer is filed under — the caller's own branch. */
  private requireBranch(principal: Principal): string {
    return this.requireBranches(principal)[0];
  }
}
