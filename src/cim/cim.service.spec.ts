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
  // Fake repo. `find` returns the seeded matches; `manager.createQueryBuilder`
  // yields a chainable builder whose `getRawMany` reports the per-customer
  // last-order aggregate. `create` echoes input; `save` resolves it with an id.
  const makeRepo = (opts?: { found?: Customer[]; rawOrders?: unknown[] }) => {
    const getRawMany = jest.fn(() => Promise.resolve(opts?.rawOrders ?? []));
    const qb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany,
    };
    const repo = {
      create: jest.fn((v: Partial<Customer>) => v as Customer),
      save: jest.fn((v: Customer) => Promise.resolve({ ...v, id: 'cust-1' })),
      find: jest.fn(() => Promise.resolve(opts?.found ?? [])),
      findOne: jest.fn(() => Promise.resolve(null)),
      manager: { createQueryBuilder: jest.fn(() => qb) },
    } as unknown as jest.Mocked<Repository<Customer>>;
    return { repo, qb };
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
    it('scopes to the caller branches, excludes soft-deleted, and ILIKEs name OR contact', async () => {
      const { repo } = makeRepo();
      const service = new CimService(repo);

      await service.search(principal(['branch-uuid-1', 'branch-uuid-2']), {
        search: 'jua',
      });

      const where = repo.find.mock.calls[0][0]?.where as Record<string, unknown>[];
      // OR of two branches: one matches on name, the other on contact_number.
      expect(Array.isArray(where)).toBe(true);
      expect(where).toHaveLength(2);
      // Both branches carry the full scope (branch + soft-delete).
      for (const clause of where) {
        expect(clause).toHaveProperty('branchId');
        expect(clause).toHaveProperty('deletedAt');
      }
      expect(where[0]).toHaveProperty('name');
      expect(where[1]).toHaveProperty('contactNumber');
      // Ordered by name, capped so the search is never unbounded.
      expect(repo.find.mock.calls[0][0]?.order).toEqual({ name: 'ASC' });
      expect(repo.find.mock.calls[0][0]?.take).toBe(20);
    });

    it('maps last_order_date per customer (null when they have no linked orders)', async () => {
      const lastOrder = new Date('2026-01-15T00:00:00Z');
      const { repo } = makeRepo({
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
    });

    it('skips the last-order aggregate when nothing matched', async () => {
      const { repo, qb } = makeRepo({ found: [] });
      const service = new CimService(repo);

      const items = await service.search(principal(['branch-uuid-1']), {
        search: 'zzz',
      });

      expect(items).toEqual([]);
      expect(qb.getRawMany).not.toHaveBeenCalled();
    });

    it('fails closed when the caller has no active branch', async () => {
      const { repo } = makeRepo();
      const service = new CimService(repo);

      await expect(
        service.search(principal([]), { search: 'jua' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(repo.find).not.toHaveBeenCalled();
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
      });

      expect(result.branchId).toBe('branch-uuid-1');
      // Server owns registration_source — never the client (story BM-031).
      expect(result.registrationSource).toBe('staff-created');
      // Free-text inputs are trimmed.
      expect(result.name).toBe('Juan Dela Cruz');
      expect(result.contactNumber).toBe('09171234567');
      expect(result.deliveryAddress).toBe('123 Rizal St');
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

    it('rejects a missing term', async () => {
      expect((await validateSearch(undefined)).length).toBeGreaterThan(0);
    });
  });
});
