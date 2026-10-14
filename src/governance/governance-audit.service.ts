import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, IsNull, MoreThanOrEqual, Repository } from 'typeorm';
import { Principal } from '../auth/principal';
import {
  GovernanceAuditCategory,
  GovernanceAuditEvent,
} from './governance-audit-event.entity';

export interface RecordGovernanceAuditInput {
  category: GovernanceAuditCategory;
  action: string;
  actor: Pick<Principal, 'userId' | 'role' | 'displayName' | 'username' | 'email'>;
  affectedRecordType: string;
  affectedRecordId?: string | null;
  branchId?: string | null;
  governanceRequestId?: string | null;
  beforeState?: Record<string, unknown> | null;
  afterState?: Record<string, unknown> | null;
  reason?: string | null;
}

/** Append-only writer for governance history. No update or delete method exists. */
@Injectable()
export class GovernanceAuditService {
  constructor(
    @InjectRepository(GovernanceAuditEvent)
    private readonly events: Repository<GovernanceAuditEvent>,
  ) {}

  async record(
    input: RecordGovernanceAuditInput,
    manager?: EntityManager,
  ): Promise<GovernanceAuditEvent> {
    const repository = manager?.getRepository(GovernanceAuditEvent) ?? this.events;
    const event = repository.create({
      category: input.category,
      action: input.action.trim(),
      actorUserId: input.actor.userId,
      actorName:
        input.actor.displayName ??
        input.actor.username ??
        input.actor.email ??
        input.actor.userId,
      actorRole:
        input.actor.role === 'super-admin' ||
        input.actor.role === 'franchise-admin' ||
        input.actor.role === 'branch-owner' ||
        input.actor.role === 'driver'
          ? input.actor.role
          : 'system',
      affectedRecordType: input.affectedRecordType.trim(),
      affectedRecordId: input.affectedRecordId ?? null,
      branchId: input.branchId ?? null,
      governanceRequestId: input.governanceRequestId ?? null,
      beforeState: input.beforeState ?? null,
      afterState: input.afterState ?? null,
      reason: input.reason?.trim() || null,
      occurredAt: new Date(),
      deletedAt: null,
    });
    return repository.save(event);
  }

  async list(category: GovernanceAuditCategory | undefined, limit: number) {
    return this.events.find({
      where: {
        ...(category ? { category } : {}),
        deletedAt: IsNull(),
      },
      order: { occurredAt: 'DESC' },
      take: limit,
    });
  }

  async count(
    category?: GovernanceAuditCategory,
    since?: Date,
  ): Promise<number> {
    return this.events.count({
      where: {
        ...(category ? { category } : {}),
        ...(since ? { occurredAt: MoreThanOrEqual(since) } : {}),
        deletedAt: IsNull(),
      },
    });
  }
}
