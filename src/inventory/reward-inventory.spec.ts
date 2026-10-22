import { INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { SupabaseJwtService } from '../auth/supabase-jwt.service';
import { Branch } from '../branches/branch.entity';
import { CatalogItem } from '../loyalty/catalog-item.entity';
import { GoTrueAdminService } from '../users/gotrue-admin.service';
import { RewardInventoryController } from './reward-inventory.controller';
import { RewardInventoryService, RewardStockRow } from './reward-inventory.service';
import { RewardStockLevel } from './reward-stock-level.entity';

const branchA = '11111111-1111-4111-8111-111111111111';
const branchB = '22222222-2222-4222-8222-222222222222';
const itemA = '33333333-3333-4333-8333-333333333333';
const itemB = '44444444-4444-4444-8444-444444444444';
let reassigned = false;
let quantities: Record<string, number> = { [branchA]: 7, [branchB]: 83 };
const item = (branchId: string) => ({
  id: branchId === branchA ? itemA : itemB, branchId, name: 'Umbrella', description: 'Household reward',
  pointsCost: 30, stockQty: quantities[branchId], isActive: true,
});
const txCatalog = {
  findOne: jest.fn().mockImplementation(({ where }: { where: { id: string; branchId: string; isActive: boolean } }) =>
    Promise.resolve(where.id === item(where.branchId).id && where.isActive ? item(where.branchId) : null)),
  save: jest.fn().mockImplementation((value: CatalogItem) => {
    quantities[value.branchId] = value.stockQty;
    return Promise.resolve(value);
  }),
};
const manager = { getRepository: jest.fn(() => txCatalog), insert: jest.fn().mockResolvedValue({}) };
const catalog = {
  find: jest.fn().mockImplementation(({ where }: { where: { branchId: string; isActive: boolean } }) => Promise.resolve(where.isActive ? [item(where.branchId)] : [])),
  manager: { transaction: jest.fn().mockImplementation(async (work: (value: typeof manager) => Promise<unknown>) => work(manager)) },
};
const targets = {
  find: jest.fn().mockResolvedValue([]),
  findOne: jest.fn().mockResolvedValue(null),
};
const branches = {
  find: jest.fn().mockImplementation(() => Promise.resolve([
    { id: branchA, name: 'Alpha', ownerId: 'owner' },
    { id: branchB, name: 'Beta', ownerId: reassigned ? 'another-owner' : 'owner' },
  ])),
  findOne: jest.fn().mockImplementation(({ where }: { where: { id: string; ownerId: string; status: string } }) => Promise.resolve(
    [branchA, branchB].includes(where.id) && where.ownerId === 'owner' && where.status === 'active' && !(reassigned && where.id === branchB)
      ? { id: where.id } : null)),
};
const jwt = { verify: jest.fn().mockImplementation((token: string) => Promise.resolve({
  sub: 'owner', app_metadata: {
    role: token === 'multi-manager' ? 'branch-manager' : token === 'legacy-owner' ? 'branch-owner' : token,
    status: 'Active',
    ...(token === 'legacy-owner' ? { branches: ['Alpha', 'Beta'] }
      : { branch_ids: token === 'branch-manager' ? [branchA] : [branchA, branchB] }),
  },
})) };

@Module({
  controllers: [RewardInventoryController],
  providers: [AuthGuard, RolesGuard, RewardInventoryService,
    { provide: getRepositoryToken(CatalogItem), useValue: catalog },
    { provide: getRepositoryToken(RewardStockLevel), useValue: targets },
    { provide: getRepositoryToken(Branch), useValue: branches },
    { provide: SupabaseJwtService, useValue: jwt },
    { provide: GoTrueAdminService, useValue: { getUser: jest.fn().mockResolvedValue({ app_metadata: { status: 'Active' } }) } },
  ],
})
class TestModule {}

describe('Reward inventory HTTP scope, canonical quantities and additive intake', () => {
  let app: INestApplication;
  let url: string;
  const headers = (role = 'branch-owner') => ({ Authorization: `Bearer ${role}`, 'Content-Type': 'application/json' });
  const ownerGet = (branchId: string, role = 'branch-owner') => fetch(`${url}/owner?branchId=${branchId}`, { headers: headers(role) });
  const intake = (payload: unknown, role = 'branch-manager') => fetch(`${url}/intake`, { method: 'POST', headers: headers(role), body: JSON.stringify(payload) });
  const readRows = async (response: Response) => await response.json() as { rewardStockLevels: RewardStockRow[] };

  beforeAll(async () => {
    app = await NestFactory.create(TestModule, { logger: false });
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    url = `${await app.getUrl()}/api/inventory/reward-stock-levels`;
  });
  afterAll(async () => { await app?.close(); });
  beforeEach(() => {
    jest.clearAllMocks();
    reassigned = false;
    quantities = { [branchA]: 7, [branchB]: 83 };
  });

  it('Manager and Owner see the same catalog stock for branch A, while B stays separate', async () => {
    const managerRows = await readRows(await fetch(`${url}?branchId=${branchA}`, { headers: headers('branch-manager') }));
    expect(await (await ownerGet(branchA)).json()).toEqual(managerRows);
    expect(managerRows.rewardStockLevels).toEqual([expect.objectContaining({ branch_id: branchA, current_qty: 7, threshold_qty: 10, capacity_qty: 100, points_cost: 30 })]);
    expect((await readRows(await ownerGet(branchB))).rewardStockLevels).toEqual([expect.objectContaining({ branch_id: branchB, current_qty: 83 })]);
    expect(catalog.find).toHaveBeenCalledWith(expect.objectContaining({ where: { branchId: branchB, isActive: true } }));
    expect(catalog.manager.transaction).not.toHaveBeenCalled();
  });

  it('reflects the canonical quantity after redemption without a second deduction or stock copy', async () => {
    quantities[branchA] = 6; // Existing approval has already decremented this catalog row.
    expect((await readRows(await ownerGet(branchA))).rewardStockLevels[0].current_qty).toBe(6);
    expect(catalog.manager.transaction).not.toHaveBeenCalled();
    expect(txCatalog.save).not.toHaveBeenCalled();
  });

  it('adds received units under a branch/item row lock without changing points or the other branch', async () => {
    const response = await intake({ catalogItemId: itemA, branchId: branchA, receivedQty: 5 });
    expect(response.status).toBe(201);
    expect((await response.json() as { rewardStockLevel: RewardStockRow }).rewardStockLevel).toMatchObject({ branch_id: branchA, current_qty: 12, points_cost: 30 });
    expect(txCatalog.findOne).toHaveBeenCalledWith({ where: { id: itemA, branchId: branchA, isActive: true }, lock: { mode: 'pessimistic_write' } });
    expect(quantities[branchB]).toBe(83);
    expect(manager.insert).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ branchId: branchA, checkedBy: 'owner' }));
    expect((await readRows(await ownerGet(branchA))).rewardStockLevels[0].current_qty).toBe(12);
  });

  it('does not discard delivered units when stock exceeds its display capacity', async () => {
    expect((await intake({ catalogItemId: itemA, receivedQty: 105 })).status).toBe(201);
    expect(quantities[branchA]).toBe(112);
  });

  it.each(['', '?branchId=invalid'])('requires a valid explicit Owner UUID: %s', async (query) => {
    expect((await fetch(`${url}/owner${query}`, { headers: headers() })).status).toBe(400);
    expect(catalog.find).not.toHaveBeenCalled();
  });

  it('denies outside-scope and reassigned Owner branches, including legacy name claims', async () => {
    expect((await ownerGet('55555555-5555-4555-8555-555555555555')).status).toBe(403);
    reassigned = true;
    expect((await ownerGet(branchB)).status).toBe(403);
    expect((await ownerGet(branchB, 'legacy-owner')).status).toBe(403);
    expect(catalog.find).not.toHaveBeenCalled();
  });

  it('rejects wrong-branch Manager selection and intake without changing any quantity', async () => {
    expect((await fetch(`${url}?branchId=${branchB}`, { headers: headers('branch-manager') })).status).toBe(403);
    expect((await intake({ catalogItemId: itemB, branchId: branchB, receivedQty: 5 })).status).toBe(403);
    expect((await intake({ catalogItemId: itemB, branchId: branchA, receivedQty: 5 })).status).toBe(404);
    expect(txCatalog.save).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, 2147483648])('validates received quantity %s', async (receivedQty) => {
    expect((await intake({ catalogItemId: itemA, receivedQty })).status).toBe(400);
    expect(txCatalog.save).not.toHaveBeenCalled();
  });

  it('keeps Owner Inventory read-only and all reward routes authenticated', async () => {
    expect((await intake({ catalogItemId: itemA, receivedQty: 1 }, 'branch-owner')).status).toBe(403);
    expect((await fetch(url, { headers: headers() })).status).toBe(403);
    expect((await fetch(`${url}/owner?branchId=${branchA}`)).status).toBe(401);
    expect((await ownerGet(branchA, 'branch-manager')).status).toBe(403);
  });

  it('preserves the existing rejection of a Manager with two active branches', async () => {
    expect((await fetch(url, { headers: headers('multi-manager') })).status).toBe(403);
    expect(catalog.find).not.toHaveBeenCalled();
  });
});
