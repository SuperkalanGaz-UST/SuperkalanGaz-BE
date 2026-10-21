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

  it('batches scoped device/position reads and accepts only matched valid distances', async () => {
    const fetchMock = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { id: 41, uniqueId: 'hardware-41', positionId: 101 },
        { id: 42, uniqueId: 'hardware-42', positionId: 102 },
        { id: 99, uniqueId: 'other-branch', positionId: 999 },
      ])))
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { id: 101, deviceId: 41, valid: true, fixTime: '2026-01-01T00:00:00Z', attributes: { totalDistance: 1250 } },
        { id: 102, deviceId: 42, valid: false, fixTime: '2026-01-01T00:00:00Z', attributes: { totalDistance: 999 } },
        { id: 999, deviceId: 99, valid: true, fixTime: '2026-01-01T00:00:00Z', attributes: { totalDistance: 5000 } },
      ])));
    expect(await makeClient().latestDistances([{ id: '41', uniqueId: 'hardware-41' }, { id: '42', uniqueId: 'hardware-42' }]))
      .toEqual([{ deviceId: '41', totalDistanceM: 1250, positionAt: new Date('2026-01-01T00:00:00Z') }]);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://192.168.1.6:8082/api/devices?id=41&id=42',
      'http://192.168.1.6:8082/api/positions?id=101&id=102',
    ]);
  });

  it('does not make unfiltered requests for an empty list or a mismatched hardware ID', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify([
      { id: 41, uniqueId: 'wrong-hardware', positionId: 101 },
    ])));
    expect(await makeClient().latestDistances([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await makeClient().latestDistances([{ id: '41', uniqueId: 'hardware-41' }])).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not immediately retry mileage reads during an outage', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('network failure'));
    await expect(makeClient().latestDistances([{ id: '41', uniqueId: 'hardware-41' }])).rejects.toThrow('Traccar is unreachable');
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
