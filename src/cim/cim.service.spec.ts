import { ForbiddenException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Repository } from 'typeorm';
import { Principal } from '../auth/principal';
import { CimService } from './cim.service';
import { Customer } from './customer.entity';
import { SearchCustomersQuery } from './dto/search-customers.query';

/**
 * Unit coverage for the CIM customer service. The focus is branch scoping, the
 * server-owned registration_source, the search match/scope rules, and the
 * assignable-customer lookup the SRD create flow relies on (panel-defense points,
 * AGENTS.md §5/§6), so the repository (and its query-builder for the last-order
 * aggregate) is faked; no database is touched.
 */
describe('CimService', () => {
  // Fake repo. The customer query builder returns the seeded matches; the
  // manager query builder reports the per-customer last-order aggregate.
  const makeRepo = (opts?: {
    found?: Customer[];
    rawOrders?: unknown[];
    selfRegistered?: Customer;
  }) => {
    const getRawMany = jest.fn(() => Promise.resolve(opts?.rawOrders ?? []));
    const orderQb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany,
    };
    const customerQb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getMany: jest.fn(() => Promise.resolve(opts?.found ?? [])),
    };
    // create() re-fetches after save() to pick up the DB-trigger-assigned
    // customer_code (migration 0029); track the saved row so the default
    // findOneByOrFail stub can echo it back with a code attached.
    let lastSaved: Customer | undefined;
    const repo = {
      create: jest.fn((v: Partial<Customer>) => v as Customer),
      save: jest.fn((v: Customer) => {
        lastSaved = { ...v, id: 'cust-1' } as Customer;
        return Promise.resolve(lastSaved);
      }),
      upsert: jest.fn(() => Promise.resolve({ identifiers: [], generatedMaps: [], raw: [] })),
      find: jest.fn(() => Promise.resolve(opts?.found ?? [])),
      findOne: jest.fn(() => Promise.resolve(null)),
      findOneByOrFail: jest.fn(() =>
        Promise.resolve(
          opts?.selfRegistered ??
            (lastSaved
              ? ({ ...lastSaved, customerCode: 'H-00001' } as Customer)
              : ({ id: 'mobile-cust-1', branchId: 'branch-uuid-1' } as Customer)),
        ),
      ),
      createQueryBuilder: jest.fn(() => customerQb),
      manager: { createQueryBuilder: jest.fn(() => orderQb) },
    } as unknown as jest.Mocked<Repository<Customer>>;
    return { repo, customerQb, orderQb };
  };

  const principal = (branchIds: string[]): Principal => ({
    userId: 'user-1',
    role: 'branch-manager',
    branches: ['Alpha'],
    branchIds,
  });

  const customer = (id: string): Customer =>
    ({ id, branchId: 'branch-uuid-1', name: id }) as Customer;

  describe('search', () => {
    it('requires a same-branch order and applies branch-scoped name/contact search', async () => {
      const { repo, customerQb } = makeRepo();
      const service = new CimService(repo);

      await service.search(principal(['branch-uuid-1', 'branch-uuid-2']), {
        search: 'jua',
      });

      expect(customerQb.where).toHaveBeenCalledWith(
        'customer.branch_id IN (:...branchIds)',
        { branchIds: ['branch-uuid-1', 'branch-uuid-2'] },
      );
      expect(customerQb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('service_request.branch_id = customer.branch_id'),
      );
      expect(customerQb.andWhere).toHaveBeenCalledWith(
        '(customer.name ILIKE :term OR customer.contact_number ILIKE :term)',
        { term: '%jua%' },
      );
      expect(customerQb.orderBy).toHaveBeenCalledWith('customer.name', 'ASC');
      expect(customerQb.take).toHaveBeenCalledWith(20);
    });

    it('maps last_order_date per customer (null when they have no linked orders)', async () => {
      const lastOrder = new Date('2026-01-15T00:00:00Z');
      const { repo, orderQb } = makeRepo({
        found: [customer('cust-1'), customer('cust-2')],
        // Only cust-1 has a linked order; cust-2 is absent → null.
        rawOrders: [{ customer_id: 'cust-1', last_order_date: lastOrder }],
      });
      const service = new CimService(repo);

      const items = await service.search(principal(['branch-uuid-1']), {
        search: 'cust',
      });

      expect(items).toHaveLength(2);
      expect(items[0].lastOrderDate).toEqual(lastOrder);
      expect(items[1].lastOrderDate).toBeNull();
      expect(orderQb.andWhere).toHaveBeenCalledWith(
        'sr.branch_id IN (:...branchIds)',
        { branchIds: ['branch-uuid-1'] },
      );
    });

    it('skips the last-order aggregate when nothing matched', async () => {
      const { repo, orderQb } = makeRepo({ found: [] });
      const service = new CimService(repo);

      const items = await service.search(principal(['branch-uuid-1']), {
        search: 'zzz',
      });

      expect(items).toEqual([]);
      expect(orderQb.getRawMany).not.toHaveBeenCalled();
    });

    it('fails closed when the caller has no active branch', async () => {
      const { repo } = makeRepo();
      const service = new CimService(repo);

      await expect(
        service.search(principal([]), { search: 'jua' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(repo.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe('create', () => {
    it('files the customer under the caller branch as staff-created and trims input', async () => {
      const { repo } = makeRepo();
      const service = new CimService(repo);

      const result = await service.create(principal(['branch-uuid-1']), {
        name: '  Juan Dela Cruz ',
        contactNumber: ' 09171234567 ',
        deliveryAddress: '  123 Rizal St ',
        accountType: 'household',
      });

      expect(result.branchId).toBe('branch-uuid-1');
      // Server owns registration_source — never the client (story BM-031).
      expect(result.registrationSource).toBe('staff-created');
      // Free-text inputs are trimmed.
      expect(result.name).toBe('Juan Dela Cruz');
      expect(result.contactNumber).toBe('09171234567');
      expect(result.deliveryAddress).toBe('123 Rizal St');
      expect(result.accountType).toBe('household');
      expect(repo.save).toHaveBeenCalledTimes(1);
    });

    it('fails closed when the caller has no active branch', async () => {
      const { repo } = makeRepo();
      const service = new CimService(repo);

      await expect(
        service.create(principal([]), {
          name: 'Juan',
          contactNumber: '09171234567',
          deliveryAddress: '123 Rizal St',
          accountType: 'household',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(repo.save).not.toHaveBeenCalled();
    });
  });

  describe('findInBranch', () => {
    it('looks up a customer by id, branch, and live (non-deleted) row', async () => {
      const { repo } = makeRepo();
      const service = new CimService(repo);

      await service.findInBranch('cust-1', 'branch-uuid-1');

      const where = repo.findOne.mock.calls[0][0]?.where as Record<string, unknown>;
      expect(where.id).toBe('cust-1');
      expect(where.branchId).toBe('branch-uuid-1');
      expect(where).toHaveProperty('deletedAt');
    });
  });

  describe('mobile customer projection', () => {
    it('upserts a self-registered profile using auth identity plus branch', async () => {
      const selfRegistered = {
        id: 'mobile-cust-1',
        branchId: 'branch-uuid-1',
        authUserId: 'auth-user-1',
      } as Customer;
      const { repo } = makeRepo({ selfRegistered });
      const service = new CimService(repo);

      const result = await service.upsertSelfRegisteredInBranch({
        authUserId: 'auth-user-1',
        branchId: 'branch-uuid-1',
        name: '  Shoti Go ',
        contactNumber: ' +639399168168 ',
        deliveryAddress: '  Las Pinas ',
        accountType: 'commercial',
      });

      expect(repo.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          branchId: 'branch-uuid-1',
          authUserId: 'auth-user-1',
          name: 'Shoti Go',
          contactNumber: '+639399168168',
          deliveryAddress: 'Las Pinas',
          registrationSource: 'self-registered',
          accountType: 'commercial',
          deletedAt: null,
        }),
        expect.objectContaining({
          conflictPaths: ['branchId', 'authUserId'],
        }),
      );
      expect(repo.findOneByOrFail).toHaveBeenCalledWith(
        expect.objectContaining({
          branchId: 'branch-uuid-1',
          authUserId: 'auth-user-1',
        }),
      );
      expect(result).toBe(selfRegistered);
    });

    it('resolves profile ids by authenticated owner for customer history', async () => {
      const { repo } = makeRepo({
        found: [customer('cust-1'), customer('cust-2')],
      });
      const service = new CimService(repo);

      await expect(service.profileIdsForAuthUser('auth-user-1')).resolves.toEqual([
        'cust-1',
        'cust-2',
      ]);
      expect(repo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ authUserId: 'auth-user-1' }),
          select: { id: true },
        }),
      );
    });
  });

  // The min-2-char / required rule is enforced by the query DTO (ValidationPipe
  // → 400), not the service, so it is covered here at the DTO level.
  describe('SearchCustomersQuery validation', () => {
    const validateSearch = (search: unknown) =>
      validate(plainToInstance(SearchCustomersQuery, { search }));

    it('accepts a term of 2+ characters', async () => {
      expect(await validateSearch('ju')).toHaveLength(0);
    });

    it('rejects a term shorter than 2 characters (after trimming)', async () => {
      expect((await validateSearch('a')).length).toBeGreaterThan(0);
      // Whitespace is trimmed before the length check, so " a " is one real char.
      expect((await validateSearch(' a ')).length).toBeGreaterThan(0);
    });

    it('accepts a missing term for the bounded customer directory listing', async () => {
      expect(await validateSearch(undefined)).toHaveLength(0);
    });
  });
});
