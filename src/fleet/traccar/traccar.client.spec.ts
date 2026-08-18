import { ConfigService } from '@nestjs/config';
import { TraccarClient } from './traccar.client';

describe('TraccarClient', () => {
  const configValues: Record<string, string> = {
    TRACCAR_BASE_URL: 'http://192.168.1.6:8082',
    TRACCAR_TOKEN: 'test-token',
    TRACCAR_TIMEOUT_MS: '5000',
    TRACCAR_RETRY_LIMIT: '1',
  };

  const makeClient = () =>
    new TraccarClient({
      get: jest.fn((name: string) => configValues[name]),
    } as unknown as ConfigService);

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('creates a Traccar device after confirming the hardware id is absent', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ id: 91, name: 'ABC-1234', uniqueId: '867530900000002' }),
          { status: 200 },
        ),
      );

    await expect(
      makeClient().provisionDevice('ABC-1234', '867530900000002'),
    ).resolves.toEqual({
      id: 91,
      name: 'ABC-1234',
      uniqueId: '867530900000002',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe('http://192.168.1.6:8082/api/devices');
    expect(fetchMock.mock.calls[1][1]?.headers).toEqual(
      expect.objectContaining({ Authorization: 'Bearer test-token' }),
    );
  });

  it('reuses an existing exact Traccar match instead of creating a duplicate', async () => {
    const existing = {
      id: 91,
      name: 'Existing device',
      uniqueId: '867530900000002',
    };
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify([existing]), { status: 200 }));

    await expect(
      makeClient().provisionDevice('ABC-1234', '867530900000002'),
    ).resolves.toEqual(existing);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses only the configured bounded retry count when Traccar is unreachable', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new TypeError('connection refused'));

    await expect(
      makeClient().provisionDevice('ABC-1234', '867530900000002'),
    ).rejects.toThrow('Traccar is unreachable');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
