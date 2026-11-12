import { HttpException, HttpStatus, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { setTimeout as delay } from 'node:timers/promises';
import { LocateBranchAddressDto } from './dto/locate-branch-address.dto';

export interface BranchAddressMatch {
  label: string;
  center: [number, number];
}

@Injectable()
export class BranchGeocodingService {
  private readonly cache = new Map<string, { expires: number; matches: BranchAddressMatch[] }>();

  constructor(private readonly config: ConfigService, private readonly database: DataSource) {}

  async locate(dto: LocateBranchAddressDto): Promise<{ matches: BranchAddressMatch[] }> {
    const query = [dto.address, dto.city, dto.province, 'Philippines'].join(', ');
    const endpoint = this.config.get<string>('BRANCH_GEOCODING_URL') ?? 'https://nominatim.openstreetmap.org/search';
    const key = `${endpoint}:${query.toLocaleLowerCase()}`;
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) return { matches: cached.matches };

    try {
      const matches = await this.database.transaction(async (manager) => {
        // Transaction-scoped lock covers ALL API instances using this database.
        // Hold it through the call plus a full second; reject concurrent calls instead of queueing.
        const rows: { locked: boolean }[] = await manager.query('SELECT pg_try_advisory_xact_lock(73842, 1) AS locked');
        if (!rows[0]?.locked) throw new HttpException('Address search is busy. Please try again in a moment.', HttpStatus.TOO_MANY_REQUESTS);
        try {
          const url = new URL(endpoint);
          url.search = new URLSearchParams({ q: query, format: 'jsonv2', countrycodes: 'ph', limit: '3', 'accept-language': 'en' }).toString();
          const response = await fetch(url, {
            headers: {
              'User-Agent': this.config.get<string>('BRANCH_GEOCODING_USER_AGENT') ?? 'SuperkalanGaz-CRM/1.0 (branch-registration; https://github.com/SuperkalanGaz-UST)',
              Accept: 'application/json',
            },
            signal: AbortSignal.timeout(6000),
          });
          if (!response.ok) throw new Error('Provider unavailable');
          const data: unknown = await response.json();
          if (!Array.isArray(data)) throw new Error('Invalid provider response');
          return data.slice(0, 3).flatMap((row: unknown): BranchAddressMatch[] => {
            if (!row || typeof row !== 'object') return [];
            const item = row as Record<string, unknown>;
            const latitude = typeof item.lat === 'string' ? Number(item.lat) : NaN;
            const longitude = typeof item.lon === 'string' ? Number(item.lon) : NaN;
            if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180 || typeof item.display_name !== 'string') return [];
            return [{ label: item.display_name.slice(0, 1000), center: [latitude, longitude] }];
          });
        } finally {
          await delay(1100);
        }
      });
      if (this.cache.size >= 500) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, { matches, expires: Date.now() + 24 * 60 * 60 * 1000 });
      return { matches };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException('Address search is unavailable. Try again or place the branch pin manually.');
    }
  }
}
