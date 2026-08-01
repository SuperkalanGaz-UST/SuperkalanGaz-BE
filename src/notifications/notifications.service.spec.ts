import { NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { Principal } from '../auth/principal';
import { NotificationReceipt } from './notification-receipt.entity';
import { StaffNotification } from './notification.entity';
import { NotificationsService } from './notifications.service';

describe('NotificationsService', () => {
  const makeNotificationsRepo = () =>
    ({
      find: jest.fn(() => Promise.resolve([])),
      findOne: jest.fn(() => Promise.resolve(null)),
      create: jest.fn((value: Partial<StaffNotification>) => value as StaffNotification),
      save: jest.fn((value: StaffNotification) => Promise.resolve(value)),
    }) as unknown as jest.Mocked<Repository<StaffNotification>>;

  const makeReceiptsRepo = () => {
    const execute = jest.fn(() => Promise.resolve({ identifiers: [] }));
    const builder = {
      insert: jest.fn(),
      into: jest.fn(),
      values: jest.fn(),
      orIgnore: jest.fn(),
      execute,
    };
    builder.insert.mockReturnValue(builder);
    builder.into.mockReturnValue(builder);
    builder.values.mockReturnValue(builder);
    builder.orIgnore.mockReturnValue(builder);

    return {
      repository: {
        find: jest.fn(() => Promise.resolve([])),
        createQueryBuilder: jest.fn(() => builder),
      } as unknown as jest.Mocked<Repository<NotificationReceipt>>,
      builder,
    };
  };

  const principal = (role: Principal['role'], branchIds: string[] = []): Principal => ({
    userId: '11111111-1111-1111-1111-111111111111',
    role,
    branches: [],
    branchIds,
  });

  it('limits a branch owner to global and own-branch rows for price or BO audiences', async () => {
    const notifications = makeNotificationsRepo();
    const { repository: receipts } = makeReceiptsRepo();
    const service = new NotificationsService(notifications, receipts);

    await service.list(principal('branch-owner', ['branch-1']), 20);

    const where = notifications.find.mock.calls[0][0]?.where;
    expect(Array.isArray(where)).toBe(true);
    expect(where).toHaveLength(4);
    expect(where).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'price-update' }),
        expect.objectContaining({ audienceRole: 'branch-owner' }),
      ]),
    );
    expect(JSON.stringify(where)).not.toContain('branch-manager');
    expect(JSON.stringify(where)).not.toContain('franchise-admin');
  });

  it('keeps FA cross-branch visibility while still restricting by audience role', async () => {
    const notifications = makeNotificationsRepo();
    const { repository: receipts } = makeReceiptsRepo();
    const service = new NotificationsService(notifications, receipts);

    await service.list(principal('franchise-admin'), 20);

    const where = notifications.find.mock.calls[0][0]?.where;
    expect(where).toHaveLength(2);
    expect(where).toEqual([
      expect.objectContaining({ type: 'price-update' }),
      expect.objectContaining({ audienceRole: 'franchise-admin' }),
    ]);
    expect(JSON.stringify(where)).not.toContain('branchId');
  });

  it('publishes price updates as global notifications for every staff role', async () => {
    const notifications = makeNotificationsRepo();
    const { repository: receipts } = makeReceiptsRepo();
    const service = new NotificationsService(notifications, receipts);

    await service.publishPriceUpdate('11kg: ₱650.00 → ₱670.00');

    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'price-update',
        audienceRole: null,
        branchId: null,
        title: 'Price update published',
      }),
    );
  });

  it('does not create a receipt for an unknown or out-of-scope notification', async () => {
    const notifications = makeNotificationsRepo();
    const { repository: receipts } = makeReceiptsRepo();
    const service = new NotificationsService(notifications, receipts);

    await expect(
      service.markRead(
        principal('branch-manager', ['branch-1']),
        '22222222-2222-2222-2222-222222222222',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(receipts.createQueryBuilder).not.toHaveBeenCalled();
  });
});
