import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Post,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RegisterDto } from './dto/register.dto';

/**
 * Public auth endpoints that do NOT require a Bearer token.
 * Currently: customer self-registration via the mobile app.
 *
 * Registration goes through the Supabase Admin API (service-role key) rather
 * than the client signUp() call so that `app_metadata.role = "customer"` is
 * set atomically at account creation time. The client-side signUp() can only
 * write `user_metadata`, which AuthGuard does not check for the role claim.
 */
@Controller('auth')
export class AuthController {
  private readonly supabaseUrl: string;
  private readonly serviceRoleKey: string;

  constructor(config: ConfigService) {
    this.supabaseUrl = config.getOrThrow<string>('SUPABASE_URL').replace(/\/$/, '');
    this.serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
  }

  /**
   * POST /api/auth/register
   *
   * Creates a new customer account via the Supabase Admin API so that
   * `app_metadata.role = "customer"` is included in the JWT from the very
   * first sign-in. Returns `{ needsConfirmation: true }` when the project
   * requires email/phone verification before the account can be used.
   *
   * This endpoint is intentionally unauthenticated — it is the first call
   * a new customer makes. Rate-limiting is delegated to Supabase Auth.
   */
  @Post('register')
  @HttpCode(200)
  async register(@Body() dto: RegisterDto): Promise<{ needsConfirmation: boolean }> {
    const isEmail = dto.method === 'email';

    // Build the credentials object for the GoTrue admin createUser call.
    const credentials = isEmail
      ? { email: dto.identifier }
      : { phone: dto.identifier };

    const body = {
      ...credentials,
      password: dto.password,
      // app_metadata.role is set here — only the service-role key can write
      // app_metadata, so the client can never forge or widen this claim.
      app_metadata: { role: 'customer' },
      user_metadata: {
        first_name: dto.firstName,
        last_name: dto.lastName,
        address: dto.address,
        account_type: dto.accountType,
        ...(dto.contactNumber ? { contact_number: dto.contactNumber } : {}),
      },
      // email_confirm=true auto-confirms the account without sending an OTP.
      // Set to false if the project requires email verification.
      email_confirm: isEmail,
      phone_confirm: !isEmail,
    };

    const res = await fetch(`${this.supabaseUrl}/auth/v1/admin/users`, {
      method: 'POST',
      headers: {
        apikey: this.serviceRoleKey,
        Authorization: `Bearer ${this.serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = (await res.json()) as Record<string, unknown>;

    if (!res.ok) {
      // Surface Supabase's error message (e.g. "User already registered") to
      // the client as a 400 so the mobile can show it inline.
      const msg =
        typeof data.msg === 'string'
          ? data.msg
          : typeof data.message === 'string'
            ? data.message
            : 'Registration failed';
      throw new BadRequestException(msg);
    }

    // When email_confirm/phone_confirm is false, the user exists but has no
    // confirmed identity yet — the mobile should show the OTP screen.
    const confirmed =
      typeof data.email_confirmed_at === 'string' ||
      typeof data.phone_confirmed_at === 'string';

    console.log('[auth] register success', {
      id: data.id,
      method: dto.method,
      accountType: dto.accountType,
      confirmed,
    });

    return { needsConfirmation: !confirmed };
  }
}
