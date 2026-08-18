import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { In, IsNull, Repository } from 'typeorm';
import { Principal } from '../auth/principal';
import { CimService } from '../cim/cim.service';
import { PayMongoService } from './paymongo.service';
import { ServiceRequest } from './service-request.entity';

export interface PaymentView {
  method: ServiceRequest['paymentMethod'];
  status: ServiceRequest['paymentStatus'];
  paidAt: Date | null;
}

export interface CheckoutView extends PaymentView {
  checkoutUrl: string | null;
}

interface PaidWebhook {
  eventId: string;
  liveMode: boolean;
  checkoutSessionId: string;
  reference: string;
  branchId: string;
  serviceRequestId: string;
  paymentId: string;
  amountCentavos: number;
  currency: string;
}

/** Customer-owned checkout/status operations and signed webhook reconciliation. */
@Injectable()
export class ServiceRequestPaymentsService {
  constructor(
    @InjectRepository(ServiceRequest)
    private readonly serviceRequests: Repository<ServiceRequest>,
    private readonly cim: CimService,
    private readonly payMongo: PayMongoService,
  ) {}

  async createCheckout(principal: Principal, id: string): Promise<CheckoutView> {
    const serviceRequest = await this.findOwned(principal, id);
    if (serviceRequest.paymentMethod !== 'PayMongo') {
      throw new BadRequestException('This Service Request uses Cash on Delivery');
    }
    if (serviceRequest.status === 'Cancelled') {
      throw new ConflictException('Cancelled Service Requests cannot be paid');
    }
    if (serviceRequest.paymentStatus === 'Paid') {
      return this.toCheckoutView(serviceRequest, false);
    }
    if (serviceRequest.paymongoCheckoutSessionId && serviceRequest.paymongoCheckoutUrl) {
      return this.toCheckoutView(serviceRequest, true);
    }

    const checkout = await this.payMongo.createCheckout(serviceRequest);
    const now = new Date();
    const result = await this.serviceRequests
      .createQueryBuilder()
      .update(ServiceRequest)
      .set({
        paymentStatus: 'Pending',
        paymongoCheckoutSessionId: checkout.id,
        paymongoCheckoutUrl: checkout.checkoutUrl,
        paymongoReference: checkout.reference,
        updatedAt: now,
      })
      .where(
        `id = :id
          AND branch_id = :branchId
          AND payment_method = :method
          AND payment_status <> :paid
          AND status <> :cancelled
          AND paymongo_checkout_session_id IS NULL`,
        {
          id: serviceRequest.id,
          branchId: serviceRequest.branchId,
          method: 'PayMongo',
          paid: 'Paid',
          cancelled: 'Cancelled',
        },
      )
      .execute();

    if (!result.affected) {
      // Concurrent calls share the same PayMongo idempotency key. Re-read only
      // through the same customer-ownership boundary and return the winner.
      const current = await this.findOwned(principal, id);
      if (current.paymentStatus === 'Paid') return this.toCheckoutView(current, false);
      if (current.paymongoCheckoutSessionId && current.paymongoCheckoutUrl) {
        return this.toCheckoutView(current, true);
      }
      throw new ConflictException('Service Request is no longer payable');
    }

    serviceRequest.paymentStatus = 'Pending';
    serviceRequest.paymongoCheckoutSessionId = checkout.id;
    serviceRequest.paymongoCheckoutUrl = checkout.checkoutUrl;
    serviceRequest.paymongoReference = checkout.reference;
    serviceRequest.updatedAt = now;
    return this.toCheckoutView(serviceRequest, true);
  }

  async status(principal: Principal, id: string): Promise<PaymentView> {
    return this.toPaymentView(await this.findOwned(principal, id));
  }

  async processPaidWebhook(
    rawBody: Buffer | undefined,
    signatureHeader: string | undefined,
    payload: unknown,
  ): Promise<void> {
    this.payMongo.verifyWebhook(rawBody, signatureHeader);
    const event = this.parsePaidWebhook(payload, rawBody);
    if (event.liveMode) {
      throw new BadRequestException('Live PayMongo events are not accepted');
    }

    // branch_id and service_request_id were inserted by this API when the
    // checkout was created. The signed payload makes them safe lookup inputs;
    // both are still required in the query so reconciliation remains scoped.
    const serviceRequest = await this.serviceRequests.findOne({
      where: {
        id: event.serviceRequestId,
        branchId: event.branchId,
        paymongoCheckoutSessionId: event.checkoutSessionId,
        deletedAt: IsNull(),
      },
    });
    if (!serviceRequest || serviceRequest.paymentMethod !== 'PayMongo') {
      throw new NotFoundException('PayMongo Service Request not found');
    }
    if (serviceRequest.status === 'Cancelled') {
      throw new ConflictException('Cancelled Service Request received a payment event');
    }

    const expectedReference = `SR-${serviceRequest.id}`;
    const expectedCentavos = Math.round(Number(serviceRequest.totalAmount) * 100);
    if (
      event.reference !== expectedReference ||
      serviceRequest.paymongoReference !== expectedReference ||
      event.currency !== 'PHP' ||
      event.amountCentavos !== expectedCentavos
    ) {
      throw new BadRequestException('PayMongo payment does not match the Service Request');
    }

    if (serviceRequest.paymentStatus === 'Paid') {
      if (serviceRequest.paymongoPaymentId !== event.paymentId) {
        throw new ConflictException('Service Request already has a different payment');
      }
      return;
    }

    const now = new Date();
    const result = await this.serviceRequests
      .createQueryBuilder()
      .update(ServiceRequest)
      .set({
        paymentStatus: 'Paid',
        paymongoPaymentId: event.paymentId,
        paymongoWebhookEventId: event.eventId,
        paymentPaidAt: now,
        updatedAt: now,
      })
      .where(
        `id = :id
          AND branch_id = :branchId
          AND paymongo_checkout_session_id = :checkoutSessionId
          AND payment_status <> :paid
          AND status <> :cancelled`,
        {
          id: serviceRequest.id,
          branchId: serviceRequest.branchId,
          checkoutSessionId: event.checkoutSessionId,
          paid: 'Paid',
          cancelled: 'Cancelled',
        },
      )
      .execute();
    if (!result.affected) {
      const current = await this.serviceRequests.findOne({
        where: {
          id: serviceRequest.id,
          branchId: serviceRequest.branchId,
          paymongoCheckoutSessionId: event.checkoutSessionId,
          deletedAt: IsNull(),
        },
      });
      if (current?.paymentStatus === 'Paid' && current.paymongoPaymentId === event.paymentId) {
        return;
      }
      throw new ConflictException('PayMongo payment could not be applied');
    }
  }

  private async findOwned(principal: Principal, id: string): Promise<ServiceRequest> {
    const profileIds = await this.cim.profileIdsForAuthUser(principal.userId);
    const ownedCustomerIds = [...new Set([principal.userId, ...profileIds])];
    const row = await this.serviceRequests.findOne({
      where: {
        id,
        customerId: In(ownedCustomerIds),
        deletedAt: IsNull(),
      },
    });
    if (!row) throw new NotFoundException('Service Request not found');
    return row;
  }

  private toPaymentView(serviceRequest: ServiceRequest): PaymentView {
    return {
      method: serviceRequest.paymentMethod,
      status: serviceRequest.paymentStatus,
      paidAt: serviceRequest.paymentPaidAt,
    };
  }

  private toCheckoutView(
    serviceRequest: ServiceRequest,
    includeUrl: boolean,
  ): CheckoutView {
    return {
      ...this.toPaymentView(serviceRequest),
      checkoutUrl: includeUrl ? serviceRequest.paymongoCheckoutUrl : null,
    };
  }

  private parsePaidWebhook(payload: unknown, rawBody: Buffer | undefined): PaidWebhook {
    const root = this.record(payload, 'Invalid PayMongo webhook body');
    const data = this.record(root.data, 'Invalid PayMongo webhook data');

    let eventType: unknown;
    let liveMode: unknown;
    let eventId: unknown;
    let sessionValue: unknown;
    if (data.type === 'checkout_session.payment.paid') {
      eventType = data.type;
      liveMode = data.livemode;
      eventId = data.id ?? root.id;
      sessionValue = data.data;
    } else {
      const attributes = this.record(data.attributes, 'Invalid PayMongo event attributes');
      eventType = attributes.type;
      liveMode = attributes.livemode;
      eventId = data.id ?? root.id;
      sessionValue = attributes.data;
    }
    if (eventType !== 'checkout_session.payment.paid' || typeof liveMode !== 'boolean') {
      throw new BadRequestException('Unsupported PayMongo webhook event');
    }

    const session = this.record(sessionValue, 'Invalid PayMongo Checkout Session');
    const sessionAttributes = this.record(
      session.attributes,
      'Invalid PayMongo Checkout Session attributes',
    );
    const metadata = this.record(sessionAttributes.metadata, 'Missing PayMongo metadata');
    const payments = Array.isArray(sessionAttributes.payments)
      ? sessionAttributes.payments
      : [];
    const paidPayment = payments
      .map((payment) => this.optionalRecord(payment))
      .find((payment) => this.optionalRecord(payment?.attributes)?.status === 'paid');
    const paymentAttributes = this.record(
      paidPayment?.attributes,
      'Missing paid PayMongo payment',
    );

    const checkoutSessionId = this.string(session.id, 'Missing checkout session id');
    const reference = this.string(sessionAttributes.reference_number, 'Missing reference number');
    const branchId = this.string(metadata.branch_id, 'Missing branch metadata');
    const serviceRequestId = this.string(
      metadata.service_request_id,
      'Missing Service Request metadata',
    );
    const paymentId = this.string(paidPayment?.id, 'Missing payment id');
    const amountCentavos = paymentAttributes.amount;
    const currency = paymentAttributes.currency;
    if (
      typeof amountCentavos !== 'number' ||
      !Number.isSafeInteger(amountCentavos) ||
      typeof currency !== 'string'
    ) {
      throw new BadRequestException('Invalid PayMongo payment amount');
    }

    return {
      eventId:
        typeof eventId === 'string' && eventId.length > 0
          ? eventId
          : `sha256:${createHash('sha256').update(rawBody ?? Buffer.alloc(0)).digest('hex')}`,
      liveMode,
      checkoutSessionId,
      reference,
      branchId,
      serviceRequestId,
      paymentId,
      amountCentavos,
      currency,
    };
  }

  private record(value: unknown, message: string): Record<string, unknown> {
    const record = this.optionalRecord(value);
    if (!record) throw new BadRequestException(message);
    return record;
  }

  private optionalRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private string(value: unknown, message: string): string {
    if (typeof value !== 'string' || value.length === 0) {
      throw new BadRequestException(message);
    }
    return value;
  }
}
