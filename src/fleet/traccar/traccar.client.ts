import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DistanceReading } from './gps-mileage';

export interface TraccarDevice {
  id: number;
  name: string;
  uniqueId: string;
}

class TraccarRequestError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'TraccarRequestError';
  }
}

/** Server-only adapter for the self-hosted Traccar middleware. Authentication
 * values never leave this class and response bodies are not copied into errors
 * or logs because they may contain middleware details. */
@Injectable()
export class TraccarClient {
  constructor(private readonly config: ConfigService) {}

  /** Two bounded batch reads, only for server-resolved devices. Fetch device
   * position IDs first: /positions?deviceId is singular, not a batch filter.
   * Never fall back to an unfiltered all-device request. */
  async latestDistances(devices: { id: string; uniqueId: string }[]): Promise<DistanceReading[]> {
    if (devices.length === 0) return [];
    if (devices.length > 100 || devices.some(({ id }) => !/^[1-9]\d*$/.test(id))) {
      throw new TraccarRequestError('Invalid device batch', false);
    }
    const expected = new Map(devices.map((device) => [device.id, device.uniqueId]));
    const deviceQuery = new URLSearchParams(devices.map(({ id }): [string, string] => ['id', id]));
    const rows = await this.request<unknown>(`/api/devices?${deviceQuery}`, { method: 'GET' }, 2000);
    if (!Array.isArray(rows)) throw new TraccarRequestError('Invalid device response', false);
    const positionIds = new Map<string, string>();
    for (const value of rows) {
      if (!value || typeof value !== 'object') continue;
      const row = value as Record<string, unknown>;
      if (
        Number.isSafeInteger(row.id) && expected.get(String(row.id)) === row.uniqueId &&
        Number.isSafeInteger(row.positionId) && Number(row.positionId) > 0
      ) positionIds.set(String(row.positionId), String(row.id));
    }
    if (positionIds.size === 0) return [];
    const query = new URLSearchParams([...positionIds.keys()].map((id): [string, string] => ['id', id]));
    const positions = await this.request<unknown>(`/api/positions?${query}`, { method: 'GET' }, 2000);
    if (!Array.isArray(positions)) throw new TraccarRequestError('Invalid position response', false);
    const readings: DistanceReading[] = [];
    for (const value of positions) {
      if (!value || typeof value !== 'object') continue;
      const row = value as Record<string, unknown>;
      const attributes = row.attributes as Record<string, unknown> | null;
      const distance = attributes?.totalDistance;
      const deviceId = String(row.deviceId);
      const positionAt = typeof row.fixTime === 'string' ? new Date(row.fixTime) : new Date(NaN);
      if (
        positionIds.get(String(row.id)) !== deviceId || !expected.has(deviceId) ||
        row.valid !== true || typeof distance !== 'number' || !Number.isFinite(distance) ||
        distance < 0 || distance >= 1e12 || !Number.isFinite(positionAt.getTime())
      ) continue;
      readings.push({ deviceId, totalDistanceM: distance, positionAt });
    }
    return readings;
  }

  /** Lookup-before-create makes a retry safe when the first POST succeeded in
   * Traccar but its response was lost to a timeout. */
  async provisionDevice(name: string, uniqueId: string): Promise<TraccarDevice> {
    const retryLimit = this.integerSetting('TRACCAR_RETRY_LIMIT', 1, 0, 3);
    let finalError: TraccarRequestError | null = null;

    for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
      try {
        const existing = await this.findByUniqueId(uniqueId);
        if (existing) return existing;
        return await this.createDevice(name, uniqueId);
      } catch (error) {
        const requestError = this.asRequestError(error);
        finalError = requestError;
        if (!requestError.retryable || attempt === retryLimit) {
          throw requestError;
        }
      }
    }

    throw finalError ?? new TraccarRequestError('Traccar provisioning failed', false);
  }

  private async findByUniqueId(uniqueId: string): Promise<TraccarDevice | null> {
    const result = await this.request<unknown[]>(
      `/api/devices?uniqueId=${encodeURIComponent(uniqueId)}`,
      { method: 'GET' },
    );
    if (!Array.isArray(result)) {
      throw new TraccarRequestError('Traccar returned an invalid device list', false);
    }

    const exactMatches = result
      .map((candidate) => this.parseDevice(candidate))
      .filter(
        (candidate): candidate is TraccarDevice =>
          candidate !== null && candidate.uniqueId === uniqueId,
      );

    if (exactMatches.length > 1) {
      throw new TraccarRequestError(
        'Traccar contains duplicate records for this hardware identifier',
        false,
      );
    }
    return exactMatches[0] ?? null;
  }

  private async createDevice(
    name: string,
    uniqueId: string,
  ): Promise<TraccarDevice> {
    const result = await this.request<unknown>('/api/devices', {
      method: 'POST',
      body: JSON.stringify({ name, uniqueId, attributes: {} }),
    });
    const device = this.parseDevice(result);
    if (!device) {
      throw new TraccarRequestError('Traccar returned an invalid device record', false);
    }
    return device;
  }

  private async request<T>(path: string, init: RequestInit, timeoutLimitMs = 30_000): Promise<T> {
    const baseUrl = this.requiredSetting('TRACCAR_BASE_URL').replace(/\/$/, '');
    const token = this.requiredSetting('TRACCAR_TOKEN');
    const timeoutMs = Math.min(this.integerSetting('TRACCAR_TIMEOUT_MS', 5000, 500, 30000), timeoutLimitMs);

    try {
      const response = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        },
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        throw new TraccarRequestError(
          `Traccar request failed with HTTP ${response.status}`,
          response.status === 409 || response.status === 429 || response.status >= 500,
        );
      }
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof TraccarRequestError) throw error;
      throw new TraccarRequestError(
        error instanceof Error && error.name === 'TimeoutError'
          ? 'Traccar request timed out'
          : 'Traccar is unreachable',
        true,
      );
    }
  }

  private parseDevice(value: unknown): TraccarDevice | null {
    if (typeof value !== 'object' || value === null) return null;
    const candidate = value as Record<string, unknown>;
    if (
      typeof candidate.id !== 'number' ||
      typeof candidate.name !== 'string' ||
      typeof candidate.uniqueId !== 'string'
    ) {
      return null;
    }
    return {
      id: candidate.id,
      name: candidate.name,
      uniqueId: candidate.uniqueId,
    };
  }

  private requiredSetting(name: string): string {
    const value = this.config.get<string>(name)?.trim();
    if (!value) {
      throw new TraccarRequestError(`${name} is not configured`, false);
    }
    return value;
  }

  private integerSetting(
    name: string,
    fallback: number,
    minimum: number,
    maximum: number,
  ): number {
    const raw = this.config.get<string>(name);
    if (!raw) return fallback;
    const value = Number(raw);
    return Number.isInteger(value) && value >= minimum && value <= maximum
      ? value
      : fallback;
  }

  private asRequestError(error: unknown): TraccarRequestError {
    return error instanceof TraccarRequestError
      ? error
      : new TraccarRequestError('Traccar provisioning failed', false);
  }
}
