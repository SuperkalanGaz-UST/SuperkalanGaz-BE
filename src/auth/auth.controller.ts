import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { AuthRegistrationService } from './auth-registration.service';
import { RegisterDto } from './dto/register.dto';
import { ResendSignUpCodeDto } from './dto/resend-sign-up-code.dto';

/**
 * Public auth endpoints that do NOT require a Bearer token.
 * Currently: customer self-registration via the mobile app.
 *
 * Registration stays behind NestJS: the service starts Supabase's signup flow
 * (which delivers the OTP) and then uses the Admin API to attach the protected
 * customer authorization claims. The mobile client cannot write app_metadata.
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly registrations: AuthRegistrationService) {}

  /**
   * POST /api/auth/register
   *
   * Creates a new customer account through Supabase Auth, then writes the
   * service-role-only customer claims. Returns `{ needsConfirmation: true }`
   * when the project requires email/phone verification before use.
   *
   * This endpoint is intentionally unauthenticated — it is the first call
   * a new customer makes. Rate-limiting is delegated to Supabase Auth.
   */
  @Post('register')
  @HttpCode(200)
  async register(@Body() dto: RegisterDto): Promise<{ needsConfirmation: boolean }> {
    return this.registrations.register(dto);
  }

  /** Sends a replacement signup code for either customer account type. */
  @Post('resend-signup-code')
  @HttpCode(200)
  async resendSignUpCode(
    @Body() dto: ResendSignUpCodeDto,
  ): Promise<{ sent: true }> {
    await this.registrations.resendSignUpCode(dto);
    return { sent: true };
  }
}
