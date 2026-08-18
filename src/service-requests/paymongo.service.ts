import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ServiceRequest } from './service-request.entity';

interface PayMongoCheckoutResponse {
  data?: {
    id?: string;
    attributes?: {
      checkout_url?: string;
      status?: string;
      payments?: Array<{
        attributes?: { status?: string };
      }>;
    };
  };
}

export interface PayMongoCheckout {
  id: string;
  checkoutUrl: string;
  reference: string;
}

/**
 * Server-only adapter for PayMongo Hosted Checkout v2 (CU-017). It deliberately
 * exposes a narrow domain API so neither controller nor mobile code handles API
 * credentials or provider payload construction.
 */
@Injectable()
export class PayMongoService {
  private readonly secretKey: string | null;
  private readonly webhookSecret: string | null;
  private readonly publicBaseUrl: string | null;
  private readonly timeoutMs: number;
  private readonly webhookToleranceSeconds: number;

  constructor(config: ConfigService) {
    const secretKey = config.get<string>('PAYMONGO_SECRET_KEY')?.trim() || null;
    const webhookSecret = config.get<string>('PAYMONGO_WEBHOOK_SECRET')?.trim() || null;
    const publicBaseUrl = config.get<string>('PAYMONGO_PUBLIC_BASE_URL')?.trim().replace(/\/$/, '') || null;

    const configuredValues = [secretKey, webhookSecret, publicBaseUrl].filter(Boolean).length;
    if (configuredValues !== 0 && configuredValues !== 3) {
      throw new Error(
        'PAYMONGO_SECRET_KEY, PAYMONGO_WEBHOOK_SECRET, and PAYMONGO_PUBLIC_BASE_URL must be configured together',
      );
    }
    if (secretKey && !secretKey.startsWith('sk_test_')) {
      throw new Error('CU-017 permits only a PayMongo sk_test_ secret key');
    }
    if (publicBaseUrl && !publicBaseUrl.startsWith('https://')) {
      throw new Error('PAYMONGO_PUBLIC_BASE_URL must be a public HTTPS origin');
    }

    this.secretKey = secretKey;
    this.webhookSecret = webhookSecret;
    this.publicBaseUrl = publicBaseUrl;
    this.timeoutMs = this.positiveInteger(
      config.get<string>('PAYMONGO_REQUEST_TIMEOUT_MS'),
      5_000,
    );
    this.webhookToleranceSeconds = this.positiveInteger(
      config.get<string>('PAYMONGO_WEBHOOK_TOLERANCE_SECONDS'),
      300,
    );
  }

  async createCheckout(serviceRequest: ServiceRequest): Promise<PayMongoCheckout> {
    const { secretKey, publicBaseUrl } = this.requireConfiguration();
    if (serviceRequest.unitPrice === null || serviceRequest.totalAmount === null) {
      throw new BadRequestException('Service Request has no payable amount');
    }

    const reference = `SR-${serviceRequest.id}`;
    const result = await this.request(
      '/v2/checkout_sessions',
      {
        method: 'POST',
        headers: {
          Authorization: this.basicAuthorization(secretKey),
          'Content-Type': 'application/json',
          'Idempotency-Key': `service-request-${serviceRequest.id}-checkout`,
        },
        body: JSON.stringify({
          data: {
            attributes: {
              line_items: [
                {
                  name: `${serviceRequest.cylinderSize} LPG cylinder`,
                  amount: this.toCentavos(serviceRequest.unitPrice),
                  currency: 'PHP',
                  quantity: serviceRequest.quantity,
                },
              ],
              payment_method_types: ['gcash', 'paymaya', 'qrph'],
              success_url: `${publicBaseUrl}/api/payments/paymongo/return/success`,
              cancel_url: `${publicBaseUrl}/api/payments/paymongo/return/cancelled`,
              reference_number: reference,
              pass_on_fees: false,
              send_email_receipt: false,
              metadata: {
                branch_id: serviceRequest.branchId,
                service_request_id: serviceRequest.id,
              },
            },
          },
        }),
      },
      true,
    );

    const payload = result as PayMongoCheckoutResponse;
    const id = payload.data?.id;
    const checkoutUrl = payload.data?.attributes?.checkout_url;
    if (!id || !checkoutUrl?.startsWith('https://checkout.paymongo.com/')) {
      throw new BadGatewayException('PayMongo returned an invalid Checkout Session');
    }
    return { id, checkoutUrl, reference };
  }

  /** Expiry is required before cancelling an unpaid online Service Request. */
  async expireCheckout(checkoutSessionId: string): Promise<void> {
    const { secretKey } = this.requireConfiguration();
    const authorization = this.basicAuthorization(secretKey);
    let expireError: unknown;
    try {
      await this.fetchWithTimeout(
        `/v1/checkout_sessions/${encodeURIComponent(checkoutSessionId)}/expire`,
        { method: 'POST', headers: { Authorization: authorization } },
      );
    } catch (error) {
      expireError = error;
    }

    // Even a 2xx expiry response can race a completed payment whose webhook is
    // still in flight. Always re-read provider state; cancellation proceeds
    // only when the session is conclusively expired and contains no paid payment.
    let stateResponse: Response;
    try {
      stateResponse = await this.fetchWithTimeout(
        `/v1/checkout_sessions/${encodeURIComponent(checkoutSessionId)}`,
        { method: 'GET', headers: { Authorization: authorization } },
      );
    } catch (error) {
      throw new ServiceUnavailableException(
        'Could not verify PayMongo checkout state; cancellation was not applied',
        { cause: expireError ?? error },
      );
    }
    if (!stateResponse.ok) {
      throw new ServiceUnavailableException(
        'Could not verify PayMongo checkout state; cancellation was not applied',
      );
    }
    const state = (await this.safeJson(stateResponse)) as PayMongoCheckoutResponse;
    const paid = state.data?.attributes?.payments?.some(
      (payment) => payment.attributes?.status === 'paid',
    );
    if (paid) {
      throw new ConflictException('Paid PayMongo Service Requests cannot be cancelled');
    }
    if (state.data?.attributes?.status !== 'expired') {
      throw new ConflictException(
        'PayMongo checkout is still active; cancellation was not applied',
      );
    }
  }

  /** Verifies PayMongo's timestamped test-mode signature over the raw bytes. */
  verifyWebhook(rawBody: Buffer | undefined, signatureHeader: string | undefined): void {
    const { webhookSecret } = this.requireConfiguration();
    if (!rawBody || !signatureHeader) {
      throw new UnauthorizedException('Missing PayMongo webhook signature');
    }

    const parts = new Map(
      signatureHeader.split(',').map((part) => {
        const [key, ...value] = part.trim().split('=');
        return [key, value.join('=')];
      }),
    );
    const timestamp = parts.get('t');
    const testSignature = parts.get('te');
    if (!timestamp || !/^\d+$/.test(timestamp) || !testSignature || !/^[a-f0-9]{64}$/i.test(testSignature)) {
      throw new UnauthorizedException('Invalid PayMongo webhook signature');
    }

    const ageSeconds = Math.abs(Date.now() / 1_000 - Number(timestamp));
    if (ageSeconds > this.webhookToleranceSeconds) {
      throw new UnauthorizedException('Stale PayMongo webhook signature');
    }

    const expected = createHmac('sha256', webhookSecret)
      .update(`${timestamp}.${rawBody.toString('utf8')}`)
      .digest();
    const received = Buffer.from(testSignature, 'hex');
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
      throw new UnauthorizedException('Invalid PayMongo webhook signature');
    }
  }

  private requireConfiguration(): {
    secretKey: string;
    webhookSecret: string;
    publicBaseUrl: string;
  } {
    if (!this.secretKey || !this.webhookSecret || !this.publicBaseUrl) {
      throw new ServiceUnavailableException('PayMongo test mode is not configured');
    }
    return {
      secretKey: this.secretKey,
      webhookSecret: this.webhookSecret,
      publicBaseUrl: this.publicBaseUrl,
    };
  }

  private async request(
    path: string,
    init: RequestInit,
    retryServerFailure: boolean,
  ): Promise<unknown> {
    const attempts = retryServerFailure ? 2 : 1;
    let lastStatus = 0;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await this.fetchWithTimeout(path, init);
        lastStatus = response.status;
        if (response.ok) return this.safeJson(response);
        if (response.status < 500 || attempt === attempts - 1) break;
      } catch (error) {
        if (attempt === attempts - 1) {
          throw new ServiceUnavailableException('PayMongo is temporarily unavailable', {
            cause: error,
          });
        }
      }
    }
    throw new BadGatewayException(`PayMongo request failed (${lastStatus || 'network error'})`);
  }

  private async fetchWithTimeout(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(`https://api.paymongo.com${path}`, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async safeJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw new BadGatewayException('PayMongo returned a non-JSON response');
    }
  }

  private basicAuthorization(secretKey: string): string {
    return `Basic ${Buffer.from(`${secretKey}:`).toString('base64')}`;
  }

  private toCentavos(amount: number): number {
    const centavos = Math.round(amount * 100);
    if (!Number.isSafeInteger(centavos) || centavos < 100) {
      throw new BadRequestException('Service Request amount is outside PayMongo limits');
    }
    return centavos;
  }

  private positiveInteger(raw: string | undefined, fallback: number): number {
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  }
}
