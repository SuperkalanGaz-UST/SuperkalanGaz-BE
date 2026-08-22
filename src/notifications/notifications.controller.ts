import { Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { Principal } from '../auth/principal';
import { CurrentPrincipal, Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { ListNotificationsQuery } from './dto/list-notifications.query';
import { NotificationView, NotificationsService } from './notifications.service';

@Controller('notifications')
@UseGuards(AuthGuard, RolesGuard)
@Roles('super-admin', 'franchise-admin', 'branch-owner', 'branch-manager')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  async list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListNotificationsQuery,
  ) {
    const result = await this.notifications.list(principal, query.limit);
    return {
      notifications: result.items.map((item) => this.toRow(item)),
      unread_count: result.unreadCount,
    };
  }

  @Post('read-all')
  async markAllRead(@CurrentPrincipal() principal: Principal) {
    return { updated: await this.notifications.markAllRead(principal) };
  }

  @Post(':id/read')
  async markRead(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.notifications.markRead(principal, id);
    return { read: true };
  }

  private toRow({ notification, isRead }: NotificationView) {
    return {
      id: notification.id,
      type: notification.type,
      title: notification.title,
      message: notification.message,
      branch_id: notification.branchId,
      created_at: notification.createdAt,
      is_read: isRead,
    };
  }
}
