import { INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { SupabaseJwtService } from '../auth/supabase-jwt.service';
import { GoTrueAdminService } from '../users/gotrue-admin.service';
import { Branch } from './branch.entity';
import { BranchesController } from './branches.controller';
import { BranchesService } from './branches.service';
import { BranchGeocodingService } from './branch-geocoding.service';
import { BranchOwnerInvitationsService } from './branch-owner-invitations.service';

const branchId = '11111111-1111-4111-8111-111111111111';
const invitations = { accept: jest.fn().mockResolvedValue(undefined), resend: jest.fn().mockResolvedValue(undefined) };
const jwt = { verify: jest.fn(async (role: string) => ({ sub: 'owner-a', email: 'owner@example.invalid', app_metadata: {
  role, status: role === 'branch-owner' ? 'Pending' : 'Active', branch_owner_invitation: true, branch_ids: [branchId],
} })) };
@Module({ controllers: [BranchesController], providers: [
  AuthGuard, RolesGuard,
  { provide: SupabaseJwtService, useValue: jwt },
  { provide: GoTrueAdminService, useValue: {} },
  { provide: getRepositoryToken(Branch), useValue: { find: async () => [{ id: branchId, name: 'Branch A', ownerId: 'owner-a' }] } },
  { provide: BranchesService, useValue: { listAssigned: jest.fn() } },
  { provide: BranchGeocodingService, useValue: {} },
  { provide: BranchOwnerInvitationsService, useValue: invitations },
] })
class TestModule {}

describe('Branch Owner invitation HTTP boundary', () => {
  let app: INestApplication;
  let url: string;
  beforeAll(async () => {
    app = await NestFactory.create(TestModule, { logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  });
  afterAll(async () => { await app?.close(); });
  beforeEach(() => { jest.clearAllMocks(); });
  const headers = (role: string) => ({ Authorization: `Bearer ${role}`, 'Content-Type': 'application/json' });

  it('accepts only the pending invitee password and derives identity/scope from JWT', async () => {
    const response = await fetch(`${url}/branches/owner-invitations/accept`, {
      method: 'POST', headers: headers('branch-owner'),
      body: JSON.stringify({ password: 'ChosenPassword1', branchId: 'forged', userId: 'forged', status: 'Active' }),
    });
    expect(response.status).toBe(201);
    expect(invitations.accept).toHaveBeenCalledWith(expect.objectContaining({ userId: 'owner-a', branchIds: [branchId], status: 'Pending' }), 'ChosenPassword1');
  });

  it.each(['short1', 'nonumericpassword', 'x'.repeat(72) + '1'])('rejects an invalid password', async (password) => {
    const response = await fetch(`${url}/branches/owner-invitations/accept`, { method: 'POST', headers: headers('branch-owner'), body: JSON.stringify({ password }) });
    expect(response.status).toBe(400);
    expect(invitations.accept).not.toHaveBeenCalled();
  });

  it.each(['super-admin', 'franchise-admin', 'branch-manager', 'customer'])('denies %s from accepting another persona invitation', async (role) => {
    const response = await fetch(`${url}/branches/owner-invitations/accept`, { method: 'POST', headers: headers(role), body: JSON.stringify({ password: 'ChosenPassword1' }) });
    expect(response.status).toBe(403);
    expect(invitations.accept).not.toHaveBeenCalled();
  });

  it('denies pending owners ordinary branch data and resend actions', async () => {
    expect((await fetch(`${url}/branches/assigned`, { headers: headers('branch-owner') })).status).toBe(403);
    expect((await fetch(`${url}/branches/${branchId}/owner-invitation/resend`, { method: 'POST', headers: headers('branch-owner') })).status).toBe(403);
  });

  it('allows the Franchise Administrator to resend and requires authentication for acceptance', async () => {
    expect((await fetch(`${url}/branches/${branchId}/owner-invitation/resend`, { method: 'POST', headers: headers('franchise-admin') })).status).toBe(201);
    expect(invitations.resend).toHaveBeenCalledWith(expect.objectContaining({ role: 'franchise-admin' }), branchId);
    expect((await fetch(`${url}/branches/owner-invitations/accept`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401);
  });
});
