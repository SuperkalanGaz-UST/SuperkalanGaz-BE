import { ConfigService } from '@nestjs/config';
import { HttpException, ServiceUnavailableException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { BranchGeocodingService } from './branch-geocoding.service';
import { BranchesController } from './branches.controller';

jest.mock('node:timers/promises', () => ({ setTimeout: jest.fn().mockResolvedValue(undefined) }));

// Mock only the transaction boundary; no real provider or database is used.
function setup(locked = true) {
  const query = jest.fn().mockResolvedValue([{ locked }]);
  const database = { transaction: (work: (manager: EntityManager) => Promise<unknown>) => work({ query } as unknown as EntityManager) } as unknown as DataSource;
  return { service: new BranchGeocodingService(new ConfigService(), database), query };
}
const address = { address: '123 Test Street', city: 'Manila', province: 'Metro Manila' };
const originalFetch = global.fetch;

afterEach(() => { global.fetch = originalFetch; jest.clearAllMocks(); });

describe('branch address lookup', () => {
  it('inherits Franchise Administrator authorization', () => {
    expect(Reflect.getMetadata('roles', BranchesController)).toEqual(['franchise-admin']);
    expect(Reflect.getMetadata('roles', BranchesController.prototype.locateAddress)).toBeUndefined();
  });

  it('restricts search to PH, sanitizes results, and caches the same address', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => [
      { display_name: 'Test branch, Manila', lat: '14.5995', lon: '120.9842', private: 'discard' },
      { display_name: 'Invalid', lat: '', lon: 'not-a-number' },
    ] });
    global.fetch = fetchMock;
    const { service } = setup();
    const result = await service.locate(address);
    expect(result.matches).toEqual([{ label: 'Test branch, Manila', center: [14.5995, 120.9842] }]);
    await service.locate(address);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0][0] as URL;
    expect(url.searchParams.get('countrycodes')).toBe('ph');
    expect(url.searchParams.get('q')).toContain('123 Test Street, Manila, Metro Manila');
  });

  it('uses the shared database lock and refuses concurrent requests before calling the provider', async () => {
    global.fetch = jest.fn();
    const { service, query } = setup(false);
    await expect(service.locate(address)).rejects.toMatchObject({ status: 429 });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('pg_try_advisory_xact_lock'));
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('reports provider failure explicitly and does not cache failed requests', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('offline'));
    const { service } = setup();
    await expect(service.locate(address)).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(service.locate(address)).rejects.toBeInstanceOf(HttpException);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});
