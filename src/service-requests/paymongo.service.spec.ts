import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { createHmac } from 'node:crypto';
import { PayMongoService } from './paymongo.service';
import { ServiceRequest } from './service-request.entity';

describe('PayMongoService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const config = (overrides: Record<string, string> = {}) => {
    const values: Record<string, string> = {
      PAYMONGO_SECRET_KEY: 'sk_test_secret',
      PAYMONGO_WEBHOOK_SECRET: 'whsk_test_secret',
      PAYMONGO_PUBLIC_BASE_URL: 'https://api.example.test',
      PAYMONGO_REQUEST_TIMEOUT_MS: '5000',
      PAYMONGO_WEBHOOK_TOLERANCE_SECONDS: '300',
      ...overrides,
    };
    return {
      get: jest.fn((key: string) => values[key]),
    } as unknown as ConfigService;
  };

  const serviceRequest = () =>
    ({
      id: '11111111-1111-4111-8111-111111111111',
      branchId: '22222222-2222-4222-8222-222222222222',
      cylinderSize: '11kg',
      quantity: 2,
      unitPrice: 650,
      totalAmount: 1300,
    }) as ServiceRequest;

  it('creates an idempotent v2 checkout from the server-owned price', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            id: 'cs_test_1',
            attributes: { checkout_url: 'https://checkout.paymongo.com/cs_test_1' },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const service = new PayMongoService(config());

    const result = await service.createCheckout(serviceRequest());

    expect(result).toEqual({
      id: 'cs_test_1',
      checkoutUrl: 'https://checkout.paymongo.com/cs_test_1',
      reference: 'SR-11111111-1111-4111-8111-111111111111',
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.paymongo.com/v2/checkout_sessions');
    expect(new Headers(init?.headers).get('Idempotency-Key')).toBe(
      'service-request-11111111-1111-4111-8111-111111111111-checkout',
    );
    const body = JSON.parse(String(init?.body)) as {
      data: { attributes: Record<string, unknown> };
    };
    expect(body.data.attributes).toEqual(
      expect.objectContaining({
        payment_method_types: ['gcash', 'paymaya', 'qrph'],
        pass_on_fees: false,
        success_url: 'https://api.example.test/api/payments/paymongo/return/success',
      }),
    );
    expect(body.data.attributes.line_items).toEqual([
      expect.objectContaining({ amount: 65000, currency: 'PHP', quantity: 2 }),
    ]);
  });

  it('verifies an expired provider state before allowing cancellation', async () => {
    const fetchMock = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { attributes: { status: 'expired', payments: [] } },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const service = new PayMongoService(config());

    await expect(service.expireCheckout('cs_test_1')).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.paymongo.com/v1/checkout_sessions/cs_test_1/expire',
    );
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://api.paymongo.com/v1/checkout_sessions/cs_test_1',
    );
  });

  it('blocks cancellation when provider state contains a paid payment', async () => {
    jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          attributes: {
            status: 'expired',
            payments: [{ attributes: { status: 'paid' } }],
          },
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const service = new PayMongoService(config());

    await expect(service.expireCheckout('cs_test_1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('verifies the timestamped test signature over the raw request bytes', () => {
    const service = new PayMongoService(config());
    const rawBody = Buffer.from('{"data":{"type":"checkout_session.payment.paid"}}');
    const timestamp = Math.floor(Date.now() / 1_000).toString();
    const signature = createHmac('sha256', 'whsk_test_secret')
      .update(`${timestamp}.${rawBody.toString('utf8')}`)
      .digest('hex');

    expect(() => service.verifyWebhook(rawBody, `t=${timestamp},te=${signature},li=`)).not.toThrow();
    expect(() => service.verifyWebhook(rawBody, `t=${timestamp},te=${'0'.repeat(64)},li=`))
      .toThrow(UnauthorizedException);
  });

  it('rejects a stale webhook even when its HMAC is otherwise valid', () => {
    const service = new PayMongoService(config({ PAYMONGO_WEBHOOK_TOLERANCE_SECONDS: '30' }));
    const rawBody = Buffer.from('{}');
    const timestamp = Math.floor(Date.now() / 1_000 - 60).toString();
    const signature = createHmac('sha256', 'whsk_test_secret')
      .update(`${timestamp}.${rawBody.toString('utf8')}`)
      .digest('hex');

    expect(() => service.verifyWebhook(rawBody, `t=${timestamp},te=${signature}`))
      .toThrow(UnauthorizedException);
  });

  it('refuses a live secret key at startup', () => {
    expect(() => new PayMongoService(config({ PAYMONGO_SECRET_KEY: 'sk_live_forbidden' })))
      .toThrow('CU-017 permits only a PayMongo sk_test_ secret key');
  });
});
