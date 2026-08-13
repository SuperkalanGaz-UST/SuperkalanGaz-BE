import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ListStoreLocationsQuery } from './dto/list-store-locations.query';
import { KnownStoreLocation } from './known-store-location.entity';

/** Hard cap on rows returned — the snapshot is ~115 rows, no pagination for MVP. */
const MAX_RESULTS = 200;

/** One reference row as served to the registration combobox. */
export interface StoreLocationRow {
  id: string;
  name: string;
  full_address: string;
  province: string | null;
  city: string | null;
  /**
   * True when some branch was provisioned from this reference (its
   * source_store_location_id equals this row's id). Such a reference cannot be
   * provisioned again, so the UI disables it. Derived ONLY from the provenance
   * link — never from matching branch names or addresses.
   */
  already_registered: boolean;
}

/**
 * Read-only access to the franchise-global known-store-location reference set.
 * This is reference data, not tenant data: there is deliberately NO branch_id
 * scoping here (AGENTS.md §5 governs tenant rows only).
 */
@Injectable()
export class ReferenceService {
  constructor(
    @InjectRepository(KnownStoreLocation)
    private readonly locations: Repository<KnownStoreLocation>,
  ) {}

  /**
   * Lists active reference locations, each tagged with already_registered.
   *
   * The provenance flag is computed in ONE query via a correlated EXISTS
   * subquery against core.branches on the provenance column — no per-row
   * lookups and no join/GROUP BY.
   *
   * We reference core.branches as a raw table (not the Branch entity) on
   * purpose: that entity is still being reconciled with the live core schema,
   * and the reference feature
   * must not depend on that unresolved work — it only needs the provenance
   * column here. TODO(branches reconciliation): once core.branches has a settled
   * soft-delete column, AND a `b.<soft-delete> IS NULL` clause to the EXISTS so a
   * retired branch frees its reference again.
   */
  async listStoreLocations(query: ListStoreLocationsQuery): Promise<StoreLocationRow[]> {
    const qb = this.locations
      .createQueryBuilder('l')
      .select('l.id', 'id')
      .addSelect('l.name', 'name')
      .addSelect('l.full_address', 'full_address')
      .addSelect('l.province', 'province')
      .addSelect('l.city', 'city')
      .addSelect(
        'EXISTS (SELECT 1 FROM core.branches b WHERE b.source_store_location_id = l.id)',
        'already_registered',
      )
      .where('l.is_active = :active', { active: true })
      .orderBy('l.name', 'ASC')
      .limit(MAX_RESULTS);

    // Case-insensitive substring match on name.
    if (query.search?.trim()) {
      qb.andWhere('l.name ILIKE :search', { search: `%${query.search.trim()}%` });
    }

    // Exact-match province filter (optional).
    if (query.province?.trim()) {
      qb.andWhere('l.province = :province', { province: query.province.trim() });
    }

    const rows = await qb.getRawMany<{
      id: string;
      name: string;
      full_address: string;
      province: string | null;
      city: string | null;
      already_registered: boolean | null;
    }>();

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      full_address: r.full_address,
      province: r.province,
      city: r.city,
      // BOOL_OR yields NULL only when no branch rows joined; treat that as false.
      already_registered: r.already_registered ?? false,
    }));
  }
}
