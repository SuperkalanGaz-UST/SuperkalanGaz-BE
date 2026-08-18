import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';
import { Repository } from 'typeorm';
import { Principal } from '../auth/principal';
import { CimService } from '../cim/cim.service';
import { PayMongoService } from './paymongo.service';
import { ServiceRequestPaymentsService } from './service-request-payments.service';
import { ServiceRequest } from './service-request.entity';

describe('ServiceRequestPaymentsService', () => {
  const customer: Principal = {
    userId: 'auth-user-1',
    role: 'customer',
    branches: [],
    branchIds: [],
  };

  const row = (overrides: Partial<ServiceRequest> = {}) =>
    ({
      id: '11111111-1111-4111-8111-111111111111',
      branchId: '22222222-2222-4222-8222-222222222222',
      customerId: 'customer-1',
      status: 'Pending',
      paymentMethod: 'PayMongo',
      paymentStatus: 'Pending',
      totalAmount: 1300,
      paymongoCheckoutSessionId: 'cs_test_1',
      paymongoCheckoutUrl: 'https://checkout.paymongo.com/cs_test_1',
      paymongoReference: 'SR-11111111-1111-4111-8111-111111111111',
      paymongoPaymentId: null,
      paymongoWebhookEventId: null,
      paymentPaidAt: null,
      deletedAt: null,
      ...overrides,
    }) as ServiceRequest;

  const setup = (serviceRequest: ServiceRequest | null = row(), updateAffected = 1) => {
    const execute = jest.fn(() => Promise.resolve({ affected: updateAffected }));
    const qb = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute,
    };
    const repo = {
      findOne: jest.fn(() => Promise.resolve(serviceRequest)),
      createQueryBuilder: jest.fn(() => qb),
    } as unknown as jest.Mocked<Repository<ServiceRequest>>;
    const cim = {
      profileIdsForAuthUser: jest.fn(() => Promise.resolve(['customer-1'])),
    } as unknown as jest.Mocked<CimService>;
    const payMongo = {
      createCheckout: jest.fn(() =>
        Promise.resolve({
          id: 'cs_test_1',
          checkoutUrl: 'https://checkout.paymongo.com/cs_test_1',
          reference: 'SR-11111111-1111-4111-8111-111111111111',
        }),
      ),
      verifyWebhook: jest.fn(),
    } as unknown as jest.Mocked<PayMongoService>;
    return {
      service: new ServiceRequestPaymentsService(repo, cim, payMongo),
      repo,
      qb,
      payMongo,
    };
  };

  const paidPayload = (overrides: {
    amount?: number;
    branchId?: string;
    checkoutSessionId?: string;
    currency?: string;
    liveMode?: boolean;
    serviceRequestId?: string;
  } = {}) => ({
    data: {
      id: 'evt_test_1',
      type: 'checkout_session.payment.paid',
      livemode: overrides.liveMode ?? false,
      data: {
        id: overrides.checkoutSessionId ?? 'cs_test_1',
        attributes: {
          reference_number: 'SR-11111111-1111-4111-8111-111111111111',
          metadata: {
            branch_id: overrides.branchId ?? '22222222-2222-4222-8222-222222222222',
            service_request_id: overrides.serviceRequestId ?? '11111111-1111-4111-8111-111111111111',
          },
          payments: [
            {
              id: 'pay_test_1',
              attributes: {
                status: 'paid',
                amount: overrides.amount ?? 130000,
                currency: overrides.currency ?? 'PHP',
              },
            },
          ],
        },
      },
    },
  });

  it('returns the existing checkout only through customer ownership lookup', async () => {
    const { service, repo, payMongo } = setup();

    const payment = await service.createCheckout(customer, row().id);

    expect(payment).toEqual({
      method: 'PayMongo',
      status: 'Pending',
      paidAt: null,
      checkoutUrl: 'https://checkout.paymongo.com/cs_test_1',
    });
    expect(repo.findOne).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: row().id }),
    });
    expect(payMongo.createCheckout).not.toHaveBeenCalled();
  });

  it('does not create or reveal checkout state for a Service Request the customer does not own', async () => {
    const { service, payMongo } = setup(null);

    await expect(service.createCheckout(customer, row().id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(payMongo.createCheckout).not.toHaveBeenCalled();
  });

  it('applies a matching signed test webhook with a branch-scoped conditional update', async () => {
    const { service, repo, qb, payMongo } = setup();

    await service.processPaidWebhook(Buffer.from('{}'), 'signature', paidPayload());

    expect(payMongo.verifyWebhook).toHaveBeenCalledWith(Buffer.from('{}'), 'signature');
    expect(repo.findOne).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: row().id,
        branchId: row().branchId,
        paymongoCheckoutSessionId: 'cs_test_1',
      }),
    });
    expect(qb.set).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentStatus: 'Paid',
        paymongoPaymentId: 'pay_test_1',
        paymongoWebhookEventId: 'evt_test_1',
      }),
    );
    expect(qb.where).toHaveBeenCalledWith(
      expect.stringContaining('branch_id = :branchId'),
      expect.objectContaining({ branchId: row().branchId }),
    );
  });

  it('rejects live-mode and wrong-amount events before writing', async () => {
    const live = setup();
    await expect(
      live.service.processPaidWebhook(Buffer.from('{}'), 'signature', paidPayload({ liveMode: true })),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(live.qb.execute).not.toHaveBeenCalled();

    const wrongAmount = setup();
    await expect(
      wrongAmount.service.processPaidWebhook(
        Buffer.from('{}'),
        'signature',
        paidPayload({ amount: 129900 }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(wrongAmount.qb.execute).not.toHaveBeenCalled();
  });

  it('rejects forged branch/session scope and a non-PHP payment', async () => {
    const forgedScope = setup(null);
    await expect(
      forgedScope.service.processPaidWebhook(
        Buffer.from('{}'),
        'signature',
        paidPayload({
          branchId: '33333333-3333-4333-8333-333333333333',
          checkoutSessionId: 'cs_forged',
        }),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(forgedScope.repo.findOne).toHaveBeenCalledWith({
      where: expect.objectContaining({
        branchId: '33333333-3333-4333-8333-333333333333',
        paymongoCheckoutSessionId: 'cs_forged',
      }),
    });

    const wrongCurrency = setup();
    await expect(
      wrongCurrency.service.processPaidWebhook(
        Buffer.from('{}'),
        'signature',
        paidPayload({ currency: 'USD' }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(wrongCurrency.qb.execute).not.toHaveBeenCalled();
  });

  it('treats a duplicate webhook for the same provider payment as a no-op', async () => {
    const alreadyPaid = row({
      paymentStatus: 'Paid',
      paymongoPaymentId: 'pay_test_1',
    });
    const { service, qb } = setup(alreadyPaid);

    await expect(
      service.processPaidWebhook(Buffer.from('{}'), 'signature', paidPayload()),
    ).resolves.toBeUndefined();
    expect(qb.execute).not.toHaveBeenCalled();
  });

  it('rejects a second different payment for an already-paid Service Request', async () => {
    const alreadyPaid = row({
      paymentStatus: 'Paid',
      paymongoPaymentId: 'pay_other',
    });
    const { service } = setup(alreadyPaid);

    await expect(
      service.processPaidWebhook(Buffer.from('{}'), 'signature', paidPayload()),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('treats a concurrent delivery that already applied the same payment as success', async () => {
    const pending = row();
    const { service, repo } = setup(pending, 0);
    repo.findOne
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(row({
        paymentStatus: 'Paid',
        paymongoPaymentId: 'pay_test_1',
      }));

    await expect(
      service.processPaidWebhook(Buffer.from('{}'), 'signature', paidPayload()),
    ).resolves.toBeUndefined();
  });
});
