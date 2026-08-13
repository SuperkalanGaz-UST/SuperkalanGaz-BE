import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { Principal } from '../auth/principal';
import { ListRidersQuery } from './dto/list-riders.query';
import { Rider } from './rider.entity';

/**
 * Fleet roster (Fleet module). This slice is minimal: list the caller's branch
 * riders for the dispatch dropdown, and an internal lookup the SRD service reuses
 * to validate a rider at dispatch time. No rider CRUD (riders are seeded
 * manually for now) and no GPS/Traccar — that is hardware-dependent and deferred
 * (AGENTS.md §8/§11).
 *
 * All scoping derives from the verified Principal, never from request input
 * (AGENTS.md §5). Isolation is enforced here in the application layer, not by the
 * DB — a missing branch filter is a cross-tenant leak.
 */
@Injectable()
export class FleetService {
  constructor(
    @InjectRepository(Rider)
    private readonly riders: Repository<Rider>,
  ) {}

  /**
   * The caller's branch roster: live riders for their own branch(es) only,
   * excluding soft-deleted rows. An optional status filter (validated upstream)
   * narrows the list — the dispatch dropdown passes 'Available'. Branch scope
   * comes from the principal; request input can never widen it (AGENTS.md §5).
   */
  async listForBranch(
    principal: Principal,
    query: ListRidersQuery,
  ): Promise<Rider[]> {
    const branchIds = this.requireBranches(principal);

    return this.riders.find({
      where: {
        branchId: In(branchIds),
        deletedAt: IsNull(),
        ...(query.status ? { status: query.status } : {}),
      },
      order: { name: 'ASC' },
    });
  }

  /**
   * Internal lookup used by the SRD dispatch flow to confirm a rider is
   * assignable to a Service Request: the rider exists, is not soft-deleted,
   * belongs to the SAME branch as the request, and is currently 'Available'.
   * Returns null when any of those fail — the caller turns that into a
   * BadRequestException. Referential integrity is checked here in the service
   * layer; the schema has no FK constraints by design (AGENTS.md §6).
   */
  async findAssignableRider(
    riderId: string,
    branchId: string,
  ): Promise<Rider | null> {
    return this.riders.findOne({
      where: {
        id: riderId,
        branchId,
        status: 'Available',
        deletedAt: IsNull(),
      },
    });
  }

  /**
   * Flip a rider to 'On Delivery' so they drop out of the Available list once
   * dispatched — prevents another Service Request picking the same rider. The
   * rider returns to 'Available' in the later "mark delivered" slice (Slice 3).
   */
  async markOnDelivery(riderId: string): Promise<void> {
    await this.riders.update(
      { id: riderId },
      { status: 'On Delivery', updatedAt: new Date() },
    );
  }

  /**
   * Return a rider to 'Available' once their Service Request is marked delivered
   * (Slice 3, story BM-007) — the inverse of markOnDelivery. Puts the rider back
   * on the dispatch roster so the branch can assign them to the next order.
   */
  async markAvailable(riderId: string): Promise<void> {
    await this.riders.update(
      { id: riderId },
      { status: 'Available', updatedAt: new Date() },
    );
  }

  /** The caller's active branch UUIDs; fails closed if they have none. */
  private requireBranches(principal: Principal): string[] {
    if (principal.branchIds.length === 0) {
      throw new ForbiddenException('Caller has no active branch');
    }
    return principal.branchIds;
  }
}
