import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';
import { DataSource, EntityManager, FindOperator, Repository } from 'typeorm';
import { Principal } from '../auth/principal';
import { Branch } from '../branches/branch.entity';
import { CimService } from '../cim/cim.service';
import { Customer } from '../cim/customer.entity';
import { CatalogItem } from './catalog-item.entity';
import { CommercialLoyaltyAccount } from './commercial-loyalty-account.entity';
import { CommercialPurchaseRecord } from './commercial-purchase-record.entity';
import { HouseholdLoyaltyAccount } from './household-loyalty-account.entity';
import { HouseholdPointTransaction } from './household-point-transaction.entity';
import { LoyaltyService } from './loyalty.service';
import { Redemption } from './redemption.entity';

type Repositories = {
  redemptions: jest.Mocked<Repository<Redemption>>;
  catalog: jest.Mocked<Repository<CatalogItem>>;
  householdAccounts: jest.Mocked<Repository<HouseholdLoyaltyAccount>>;
  commercialAccounts: jest.Mocked<Repository<CommercialLoyaltyAccount>>;
  commercialPurchases: jest.Mocked<Repository<CommercialPurchaseRecord>>;
  ledger: jest.Mocked<Repository<HouseholdPointTransaction>>;
  branches: jest.Mocked<Repository<Branch>>;
};

const repository = <T extends object>(): jest.Mocked<Repository<T>> =>
  ({
    find: jest.fn(() => Promise.resolve([])),
    findOne: jest.fn(() => Promise.resolve(null)),
  }) as unknown as jest.Mocked<Repository<T>>;

const makeService = () => {
  const repos: Repositories = {
    redemptions: repository<Redemption>(),
    catalog: repository<CatalogItem>(),
    householdAccounts: repository<HouseholdLoyaltyAccount>(),
    commercialAccounts: repository<CommercialLoyaltyAccount>(),
    commercialPurchases: repository<CommercialPurchaseRecord>(),
    ledger: repository<HouseholdPointTransaction>(),
    branches: repository<Branch>(),
  };
  const cim = {
    findInBranch: jest.fn(() => Promise.resolve(null)),
    findInBranches: jest.fn(() => Promise.resolve(null)),
    profilesForAuthUser: jest.fn(() => Promise.resolve([])),
  } as unknown as jest.Mocked<CimService>;
  const dataSource = {
    transaction: jest.fn(),
  } as unknown as jest.Mocked<DataSource>;
  const service = new LoyaltyService(
    repos.redemptions,
    repos.catalog,
    repos.householdAccounts,
    repos.commercialAccounts,
    repos.commercialPurchases,
    repos.ledger,
    repos.branches,
    dataSource,
    cim,
  );
  return { service, repos, cim };
};

const customerPrincipal = (accountType: 'household' | 'commercial'): Principal => ({
  userId: 'auth-user-1',
  role: 'customer',
  accountType,
  branches: [],
  branchIds: [],
});

const bmPrincipal = (): Principal => ({
  userId: 'bm-1',
  role: 'branch-manager',
  branches: ['Alpha'],
  branchIds: ['branch-1'],
});

describe('LoyaltyService track separation', () => {
  it('routes a household delivery only to the household points ledger', async () => {
    const { service, cim } = makeService();
    cim.findInBranch.mockResolvedValue({
      id: 'customer-1',
      branchId: 'branch-1',
      accountType: 'household',
    } as Customer);
    const household = jest.spyOn(service, 'recordHouseholdEarn').mockResolvedValue();
    const commercial = jest.spyOn(service, 'recordCommercialPurchase').mockResolvedValue();

    await service.recordDeliveredPurchase('customer-1', 'branch-1', 'request-1', '11kg', 2);

    expect(household).toHaveBeenCalledWith(
      'customer-1',
      'branch-1',
      'request-1',
      '11kg',
      2,
    );
    expect(commercial).not.toHaveBeenCalled();
  });

  it('routes a commercial delivery only to the 30+1 purchase ledger', async () => {
    const { service, cim } = makeService();
    cim.findInBranch.mockResolvedValue({
      id: 'customer-1',
      branchId: 'branch-1',
      accountType: 'commercial',
    } as Customer);
    const household = jest.spyOn(service, 'recordHouseholdEarn').mockResolvedValue();
    const commercial = jest.spyOn(service, 'recordCommercialPurchase').mockResolvedValue();

    await service.recordDeliveredPurchase('customer-1', 'branch-1', 'request-1', '11kg', 2);

    expect(commercial).toHaveBeenCalledWith('customer-1', 'branch-1', 'request-1');
    expect(household).not.toHaveBeenCalled();
  });

  it('scopes the customer household catalog to owned CIM branches', async () => {
    const { service, repos, cim } = makeService();
    cim.profilesForAuthUser.mockResolvedValue([
      { id: 'customer-1', branchId: 'branch-1', accountType: 'household' },
      { id: 'customer-2', branchId: 'branch-2', accountType: 'household' },
    ]);

    await service.getCustomerCatalog(customerPrincipal('household'));

    const where = repos.catalog.find.mock.calls[0][0]?.where as {
      branchId: FindOperator<string>;
      isActive: boolean;
    };
    expect(where.branchId.value).toEqual(['branch-1', 'branch-2']);
    expect(where.isActive).toBe(true);
  });

  it('returns only commercial data for a commercial customer', async () => {
    const { service, repos, cim } = makeService();
    cim.profilesForAuthUser.mockResolvedValue([
      { id: 'customer-1', branchId: 'branch-1', accountType: 'commercial' },
    ]);
    repos.commercialAccounts.find.mockResolvedValue([
      {
        customerId: 'customer-1',
        branchId: 'branch-1',
        currentCycleCount: 9,
        completedCycles: 1,
      } as CommercialLoyaltyAccount,
    ]);
    repos.branches.find.mockResolvedValue([{ id: 'branch-1', name: 'Alpha' } as Branch]);

    const view = await service.getCustomerLedger(customerPrincipal('commercial'));

    expect(view.track).toBe('commercial_30plus1');
    expect(view.householdTransactions).toEqual([]);
    expect(view.commercialAccounts[0]).toEqual({
      branchId: 'branch-1',
      branchName: 'Alpha',
      currentCycleCount: 9,
      completedCycles: 1,
    });
    expect(repos.householdAccounts.find).not.toHaveBeenCalled();
    expect(repos.ledger.find).not.toHaveBeenCalled();
  });

  it('fails closed when a customer has no protected account-type claim', async () => {
    const { service } = makeService();
    await expect(
      service.getCustomerLedger({
        userId: 'auth-user-1',
        role: 'customer',
        branches: [],
        branchIds: [],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('expires only the unspent remainder of a due household earn lot', async () => {
    const { service } = makeService();
    const account = {
      id: 'account-1',
      customerId: 'customer-1',
      branchId: 'branch-1',
      pointsBalance: 70,
    } as HouseholdLoyaltyAccount;
    const earn = {
      id: 'earn-1',
      accountId: account.id,
      type: 'earn',
      pointsDelta: 100,
      expiresAt: new Date('2026-01-01T00:00:00.000Z'),
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
    } as HouseholdPointTransaction;
    const redeem = {
      id: 'redeem-1',
      accountId: account.id,
      type: 'redeem',
      pointsDelta: -30,
      sourcePointTransactionId: null,
      createdAt: new Date('2025-06-01T00:00:00.000Z'),
    } as HouseholdPointTransaction;
    const manager = {
      find: jest.fn(() => Promise.resolve([earn, redeem])),
      create: jest.fn((_entity, value) => value),
      save: jest.fn((_entity, value) => Promise.resolve(value)),
      update: jest.fn(() => Promise.resolve({ affected: 1 })),
    } as unknown as jest.Mocked<EntityManager>;

    const expiry = service as unknown as {
      expireHouseholdPointsInTx: (
        entityManager: EntityManager,
        householdAccount: HouseholdLoyaltyAccount,
        now: Date,
      ) => Promise<void>;
    };
    await expiry.expireHouseholdPointsInTx(
      manager,
      account,
      new Date('2026-02-01T00:00:00.000Z'),
    );

    expect(manager.save).toHaveBeenCalledWith(
      HouseholdPointTransaction,
      expect.objectContaining({
        type: 'expire',
        pointsDelta: -70,
        sourcePointTransactionId: 'earn-1',
      }),
    );
    expect(manager.update).toHaveBeenCalledWith(
      HouseholdLoyaltyAccount,
      { id: account.id },
      expect.objectContaining({ pointsBalance: 0 }),
    );
  });
});

describe('LoyaltyService.getCustomerLedgerByCimId (Customer Directory detail view)', () => {
  it('returns only the household points figures for a household customer, never commercial fields', async () => {
    const { service, repos, cim } = makeService();
    cim.findInBranches.mockResolvedValue({
      id: 'customer-1',
      branchId: 'branch-1',
      accountType: 'household',
      name: 'Juana Dela Cruz',
    } as Customer);
    repos.householdAccounts.findOne.mockResolvedValue({
      id: 'account-1',
      customerId: 'customer-1',
      branchId: 'branch-1',
      pointsBalance: 120,
    } as HouseholdLoyaltyAccount);

    const view = await service.getCustomerLedgerByCimId(bmPrincipal(), 'customer-1');

    expect(view.track).toBe('household_points');
    expect(view.pointsBalance).toBe(120);
    expect(view.completedCycles).toBeNull();
    expect(view.currentCycleCount).toBeNull();
    expect(view.commercialPurchases).toEqual([]);
    expect(repos.commercialAccounts.findOne).not.toHaveBeenCalled();
  });

  it('returns only the commercial cycle figures for a commercial customer, never a household points balance', async () => {
    const { service, repos, cim } = makeService();
    cim.findInBranches.mockResolvedValue({
      id: 'customer-2',
      branchId: 'branch-1',
      accountType: 'commercial',
      name: 'Sari-Sari Store ni Aling Nena',
    } as Customer);
    repos.commercialAccounts.findOne.mockResolvedValue({
      customerId: 'customer-2',
      branchId: 'branch-1',
      currentCycleCount: 14,
      completedCycles: 2,
    } as CommercialLoyaltyAccount);

    const view = await service.getCustomerLedgerByCimId(bmPrincipal(), 'customer-2');

    expect(view.track).toBe('commercial_30plus1');
    expect(view.currentCycleCount).toBe(14);
    expect(view.completedCycles).toBe(2);
    expect(view.pointsBalance).toBeNull();
    expect(view.householdTransactions).toEqual([]);
    expect(repos.householdAccounts.findOne).not.toHaveBeenCalled();
  });

  it('404s when the customer id is unknown or outside the caller branch scope', async () => {
    const { service, cim } = makeService();
    cim.findInBranches.mockResolvedValue(null);

    await expect(
      service.getCustomerLedgerByCimId(bmPrincipal(), 'not-found'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
