import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ExecutionContext } from '@nestjs/common/interfaces';
import { Request } from 'express';
import { Repository } from 'typeorm';
import { Branch } from '../branches/branch.entity';
import { AuthGuard } from './auth.guard';
import { Principal, REQUEST_PRINCIPAL } from './principal';
import { SupabaseJwtService } from './supabase-jwt.service';

const firstBranchId = '11111111-1111-4111-8111-111111111111';
const secondBranchId = '22222222-2222-4222-8222-222222222222';

function contextFor(request: Partial<Request>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
  } as unknown as ExecutionContext;
}

describe('AuthGuard UUID branch scope', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('intersects a Branch Owner claim with the canonical owner_id assignment', async () => {
    const request = {
      headers: { authorization: 'Bearer token' },
      method: 'GET',
      originalUrl: '/api/branches/assigned',
    } as Partial<Request>;
    const jwt = {
      verify: jest.fn().mockResolvedValue({
        sub: 'owner-1',
        app_metadata: {
          role: 'branch-owner',
          status: 'Active',
          branch_ids: [firstBranchId, secondBranchId],
        },
      }),
    } as unknown as SupabaseJwtService;
    const branches = {
      find: jest.fn().mockResolvedValue([
        { id: firstBranchId, name: 'Alpha', ownerId: 'owner-1' },
        { id: secondBranchId, name: 'Beta', ownerId: 'owner-2' },
      ]),
    } as unknown as Repository<Branch>;
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(false),
    } as unknown as Reflector;
    const guard = new AuthGuard(jwt, reflector, branches);

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    const principal = (request as Record<string, unknown>)[REQUEST_PRINCIPAL] as Principal;
    expect(principal.branchIds).toEqual([firstBranchId]);
    expect(principal.branches).toEqual(['Alpha']);
  });

  it('fails closed when a Branch Manager resolves to multiple active branches', async () => {
    const request = {
      headers: { authorization: 'Bearer token' },
      method: 'GET',
      originalUrl: '/api/users/me',
    } as Partial<Request>;
    const jwt = {
      verify: jest.fn().mockResolvedValue({
        sub: 'manager-1',
        app_metadata: {
          role: 'branch-manager',
          status: 'Active',
          branch_ids: [firstBranchId, secondBranchId],
        },
      }),
    } as unknown as SupabaseJwtService;
    const branches = {
      find: jest.fn().mockResolvedValue([
        { id: firstBranchId, name: 'Alpha', ownerId: 'owner-1' },
        { id: secondBranchId, name: 'Beta', ownerId: 'owner-2' },
      ]),
    } as unknown as Repository<Branch>;
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(false),
    } as unknown as Reflector;
    const guard = new AuthGuard(jwt, reflector, branches);

    await expect(guard.canActivate(contextFor(request))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('allows a pending Delivery Rider only on an invitation-decorated endpoint', async () => {
    const request = {
      headers: { authorization: 'Bearer token' },
      method: 'GET',
      originalUrl: '/api/delivery-rider-invitations/session/acceptance',
    } as Partial<Request>;
    const jwt = {
      verify: jest.fn().mockResolvedValue({
        sub: 'driver-1',
        email: 'driver@example.com',
        app_metadata: {
          role: 'driver',
          status: 'Pending',
          branch_ids: [firstBranchId],
        },
      }),
    } as unknown as SupabaseJwtService;
    const branches = {
      find: jest.fn().mockResolvedValue([
        { id: firstBranchId, name: 'Alpha', ownerId: 'owner-1' },
      ]),
    } as unknown as Repository<Branch>;
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(true),
    } as unknown as Reflector;
    const guard = new AuthGuard(jwt, reflector, branches);

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    const principal = (request as Record<string, unknown>)[REQUEST_PRINCIPAL] as Principal;
    expect(principal).toMatchObject({
      userId: 'driver-1',
      role: 'driver',
      status: 'Pending',
      branchIds: [firstBranchId],
    });
  });

  it('rejects a pending Delivery Rider on normal protected endpoints', async () => {
    const request = {
      headers: { authorization: 'Bearer token' },
      method: 'GET',
      originalUrl: '/api/delivery-rider/me',
    } as Partial<Request>;
    const jwt = {
      verify: jest.fn().mockResolvedValue({
        sub: 'driver-1',
        app_metadata: {
          role: 'driver',
          status: 'Pending',
          branch_ids: [firstBranchId],
        },
      }),
    } as unknown as SupabaseJwtService;
    const branches = { find: jest.fn() } as unknown as Repository<Branch>;
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(false),
    } as unknown as Reflector;
    const guard = new AuthGuard(jwt, reflector, branches);

    await expect(guard.canActivate(contextFor(request))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
