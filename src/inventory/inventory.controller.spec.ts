import { INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AuthGuard } from '../auth/auth.guard';
import { ROLES } from '../auth/principal';
import { RolesGuard } from '../auth/roles.guard';
import { SupabaseJwtService } from '../auth/supabase-jwt.service';
import { Branch } from '../branches/branch.entity';
import { GoTrueAdminService } from '../users/gotrue-admin.service';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';

const branchId = '11111111-1111-4111-8111-111111111111';
const branchB = '22222222-2222-4222-8222-222222222222';
const inventory = {
  listForOwner: jest.fn().mockResolvedValue([]),
  listForBranch: jest.fn().mockResolvedValue([]),
  intake: jest.fn(),
  logStockCheck: jest.fn(),
};
const branches = { find: jest.fn().mockResolvedValue([
  { id: branchId, name: 'Alpha', ownerId: 'owner' },
  { id: branchB, name: 'Beta', ownerId: 'owner' },
]) };
const jwt = { verify: jest.fn().mockImplementation((role: string) => Promise.resolve({
  sub: 'owner',
  app_metadata: {
    role: role === 'multi-manager' ? 'branch-manager' : role,
    status: 'Active',
    branch_ids: role === 'branch-manager' ? [branchId] : [branchId, branchB],
  },
})) };

@Module({
  controllers: [InventoryController],
  providers: [
    AuthGuard, RolesGuard,
    { provide: InventoryService, useValue: inventory },
    { provide: SupabaseJwtService, useValue: jwt },
    { provide: GoTrueAdminService, useValue: { getUser: jest.fn().mockResolvedValue({ app_metadata: { status: 'Active' } }) } },
    { provide: getRepositoryToken(Branch), useValue: branches },
  ],
})
class TestModule {}

describe('Inventory HTTP read-only Owner boundary', () => {
  let app: INestApplication;
  let url: string;
  const headers = (role: string) => ({ Authorization: `Bearer ${role}` });

  beforeAll(async () => {
    app = await NestFactory.create(TestModule, { logger: false });
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    url = `${await app.getUrl()}/api/inventory`;
  });
  afterAll(async () => { await app?.close(); });
  beforeEach(() => { jest.clearAllMocks(); });

  it('passes the explicitly selected UUID to the Owner service', async () => {
    const response = await fetch(`${url}/stock-levels/owner?branchId=${branchB}`, { headers: headers('branch-owner') });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ stockLevels: [] });
    expect(inventory.listForOwner).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'branch-owner', branchIds: [branchId, branchB] }), branchB,
    );
    expect(inventory.intake).not.toHaveBeenCalled();
    expect(inventory.logStockCheck).not.toHaveBeenCalled();
  });

  it.each(['', '?branchId=not-a-uuid'])('rejects missing or malformed branch selection: %s', async (query) => {
    const response = await fetch(`${url}/stock-levels/owner${query}`, { headers: headers('branch-owner') });
    expect(response.status).toBe(400);
    expect(inventory.listForOwner).not.toHaveBeenCalled();
  });

  it('requires authentication', async () => {
    expect((await fetch(`${url}/stock-levels/owner?branchId=${branchId}`)).status).toBe(401);
  });

  it.each(ROLES.filter((role) => role !== 'branch-owner'))('denies %s on the Owner read route', async (role) => {
    expect((await fetch(`${url}/stock-levels/owner?branchId=${branchId}`, { headers: headers(role) })).status).toBe(403);
    expect(inventory.listForOwner).not.toHaveBeenCalled();
  });

  it('keeps every existing Manager route closed to Owners', async () => {
    for (const [path, method] of [['stock-levels', 'GET'], ['stock-levels/intake', 'POST'], ['stock-checks', 'POST']]) {
      expect((await fetch(`${url}/${path}`, { method, headers: headers('branch-owner') })).status).toBe(403);
    }
    expect(inventory.listForBranch).not.toHaveBeenCalled();
    expect(inventory.intake).not.toHaveBeenCalled();
    expect(inventory.logStockCheck).not.toHaveBeenCalled();
  });

  it('has no Owner write route', async () => {
    for (const method of ['POST', 'PATCH', 'DELETE']) {
      expect((await fetch(`${url}/stock-levels/owner?branchId=${branchId}`, { method, headers: headers('branch-owner') })).status).toBe(404);
    }
  });

  it('preserves Manager token scoping and rejects two active Manager branches', async () => {
    expect((await fetch(`${url}/stock-levels?branchId=${branchB}`, { headers: headers('branch-manager') })).status).toBe(200);
    expect(inventory.listForBranch).toHaveBeenCalledWith(expect.objectContaining({ branchIds: [branchId] }));
    expect((await fetch(`${url}/stock-levels`, { headers: headers('multi-manager') })).status).toBe(403);
  });
});
