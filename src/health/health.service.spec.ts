import { ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { HealthService } from './health.service';

describe('HealthService', () => {
  const query = jest.fn<Promise<unknown>, [string]>();
  const service = new HealthService({ query } as unknown as DataSource);

  beforeEach(() => {
    query.mockReset();
  });

  it('reports liveness without querying dependencies', () => {
    expect(service.live()).toEqual({ status: 'ok' });
    expect(query).not.toHaveBeenCalled();
  });

  it('reports readiness only after the database responds', async () => {
    query.mockResolvedValue([{ '?column?': 1 }]);

    await expect(service.ready()).resolves.toEqual({ status: 'ready' });
    expect(query).toHaveBeenCalledWith('SELECT 1');
  });

  it('returns a generic unavailable error when the database is down', async () => {
    query.mockRejectedValue(new Error('private database connection detail'));

    await expect(service.ready()).rejects.toThrow(
      new ServiceUnavailableException('API dependencies are unavailable'),
    );
  });
});
