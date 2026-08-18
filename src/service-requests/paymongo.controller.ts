import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  RawBodyRequest,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ServiceRequestPaymentsService } from './service-request-payments.service';

/** Public provider callbacks. Authentication is the PayMongo HMAC, not a CRM JWT. */
@Controller('payments/paymongo')
export class PayMongoController {
  constructor(private readonly payments: ServiceRequestPaymentsService) {}

  @Post('webhook')
  async webhook(
    @Req() request: RawBodyRequest<Request>,
    @Body() payload: unknown,
  ): Promise<{ received: true }> {
    const signature = request.headers['paymongo-signature'];
    await this.payments.processPaidWebhook(
      request.rawBody,
      Array.isArray(signature) ? signature[0] : signature,
      payload,
    );
    return { received: true };
  }

  /** HTTPS bounce required by Hosted Checkout; the app still polls API state. */
  @Get('return/:result')
  returnToApp(
    @Param('result') result: string,
    @Res() response: Response,
  ): void {
    const safeResult = result === 'success' ? 'success' : 'cancelled';
    response.redirect(`superkalan://payments/return?result=${safeResult}`);
  }
}
