import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, FindOptionsWhere, In, IsNull, Repository } from 'typeorm';
import { Principal, Role } from '../auth/principal';
import { NotificationReceipt } from './notification-receipt.entity';
import { NotificationType, StaffNotification } from './notification.entity';

export interface NotificationView {
  notification: StaffNotification;
  isRead: boolean;
}

export interface RoleNotificationInput {
  type: Exclude<NotificationType, 'price-update'>;
  audienceRole: Role;
  branchId?: string | null;
  title: string;
  message: string;
}

/**
 * Server-side notification RBAC. The browser never supplies its role or branch
 * scope: both come from the verified Principal. SA/FA can read role-addressed
 * notifications across branches; BO/BM can only read their own branch rows.
 * Global price updates are visible to every staff role.
 */
@Injectable()
export class NotificationsService {
  constructor(
    @InjectRepository(StaffNotification)
    private readonly notifications: Repository<StaffNotification>,
    @InjectRepository(NotificationReceipt)
    private readonly receipts: Repository<NotificationReceipt>,
  ) {}

  async list(
    principal: Principal,
    limit: number,
  ): Promise<{ items: NotificationView[]; unreadCount: number }> {
    const visible = await this.findVisible(principal);
    const notificationIds = visible.map((notification) => notification.id);
    const readIds = await this.findReadIds(principal.userId, notificationIds);

    return {
      items: visible.slice(0, limit).map((notification) => ({
        notification,
        isRead: readIds.has(notification.id),
      })),
      unreadCount: visible.reduce(
        (count, notification) => count + (readIds.has(notification.id) ? 0 : 1),
        0,
      ),
    };
  }

  async markRead(principal: Principal, notificationId: string): Promise<void> {
    const notification = await this.findVisibleById(principal, notificationId);
    if (!notification) {
      // Unknown and out-of-scope IDs are deliberately indistinguishable.
      throw new NotFoundException('Notification not found');
    }

    const now = new Date();
    await this.receipts
      .createQueryBuilder()
      .insert()
      .into(NotificationReceipt)
      .values({
        notificationId: notification.id,
        userId: principal.userId,
        readAt: now,
        createdAt: now,
      })
      .orIgnore()
      .execute();
  }

  async markAllRead(principal: Principal): Promise<number> {
    const visible = await this.findVisible(principal);
    const ids = visible.map((notification) => notification.id);
    const readIds = await this.findReadIds(principal.userId, ids);
    const unread = ids.filter((id) => !readIds.has(id));
    if (unread.length === 0) return 0;

    const now = new Date();
    await this.receipts
      .createQueryBuilder()
      .insert()
      .into(NotificationReceipt)
      .values(
        unread.map((notificationId) => ({
          notificationId,
          userId: principal.userId,
          readAt: now,
          createdAt: now,
        })),
      )
      .orIgnore()
      .execute();
    return unread.length;
  }

  /** An approved price publication is always global, regardless of branch membership. */
  async publishPriceUpdate(
    message: string,
    manager?: EntityManager,
  ): Promise<StaffNotification> {
    const now = new Date();
    const notifications = manager?.getRepository(StaffNotification) ?? this.notifications;
    return notifications.save(
      notifications.create({
        type: 'price-update',
        audienceRole: null,
        branchId: null,
        title: 'Price update published',
        message: message.trim(),
        createdAt: now,
        deletedAt: null,
      }),
    );
  }

  /**
   * Domain services use this method for non-price events (complaints, branch
   * approvals, service requests, etc.). The explicit role and optional branch
   * become the server-enforced audience; there is intentionally no generic
   * public controller that lets a browser forge notifications.
   */
  async publishForRole(input: RoleNotificationInput): Promise<StaffNotification> {
    const now = new Date();
    return this.notifications.save(
      this.notifications.create({
        ...input,
        branchId: input.branchId ?? null,
        title: input.title.trim(),
        message: input.message.trim(),
        createdAt: now,
        deletedAt: null,
      }),
    );
  }

  private async findVisible(principal: Principal): Promise<StaffNotification[]> {
    return this.notifications.find({
      where: this.visibilityWhere(principal),
      order: { createdAt: 'DESC' },
    });
  }

  private async findVisibleById(
    principal: Principal,
    id: string,
  ): Promise<StaffNotification | null> {
    const where = this.visibilityWhere(principal).map((scope) => ({ ...scope, id }));
    return this.notifications.findOne({ where });
  }

  private visibilityWhere(principal: Principal): FindOptionsWhere<StaffNotification>[] {
    const audiences: FindOptionsWhere<StaffNotification>[] = [
      { type: 'price-update', deletedAt: IsNull() },
      { audienceRole: principal.role, deletedAt: IsNull() },
    ];

    // SA/FA have cross-branch read visibility. BO/BM fail closed to their own live
    // branch UUIDs plus genuinely global rows for their role.
    if (principal.role === 'franchise-admin' || principal.role === 'super-admin') {
      return audiences;
    }

    const scoped: FindOptionsWhere<StaffNotification>[] = [];
    for (const audience of audiences) {
      scoped.push({ ...audience, branchId: IsNull() });
      if (principal.branchIds.length > 0) {
        scoped.push({ ...audience, branchId: In(principal.branchIds) });
      }
    }
    return scoped;
  }

  private async findReadIds(userId: string, notificationIds: string[]): Promise<Set<string>> {
    if (notificationIds.length === 0) return new Set();

    const receipts = await this.receipts.find({
      where: { userId, notificationId: In(notificationIds) },
      select: { notificationId: true },
    });
    return new Set(receipts.map((receipt) => receipt.notificationId));
  }
}
