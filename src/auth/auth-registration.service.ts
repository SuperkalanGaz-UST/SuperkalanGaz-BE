import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RegisterDto } from './dto/register.dto';
import { ResendSignUpCodeDto } from './dto/resend-sign-up-code.dto';

type AuthJson = Record<string, unknown>;

/**
 * Runs customer signup through GoTrue's public signup flow so Supabase actually
 * generates and delivers the confirmation OTP. Authorization claims are then
 * added through the Admin API and remain impossible for the client to forge.
 */
@Injectable()
export class AuthRegistrationService {
  private readonly authBaseUrl: string;
  private readonly publishableKey: string;
  private readonly serviceRoleKey: string;

  constructor(config: ConfigService) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL').replace(/\/$/, '');
    this.authBaseUrl = `${supabaseUrl}/auth/v1`;
    this.serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    // Prefer the least-privileged public key. Existing deployments that have
    // not added it yet can still use the server-only service key as the API
    // gateway credential; it is never returned to the mobile client.
    this.publishableKey =
      config.get<string>('SUPABASE_ANON_KEY')?.trim() || this.serviceRoleKey;
  }

  async register(dto: RegisterDto): Promise<{ needsConfirmation: boolean }> {
    const identifier = this.normalizedIdentifier(dto.method, dto.identifier);
    const credentials =
      dto.method === 'email'
        ? { email: identifier }
        : { phone: identifier, channel: 'sms' };

    const data = await this.publicAuthRequest('/signup', {
      ...credentials,
      password: dto.password,
      data: {
        first_name: dto.firstName.trim(),
        last_name: dto.lastName.trim(),
        address: dto.address.trim(),
        account_type: dto.accountType,
        ...(dto.contactNumber ? { contact_number: dto.contactNumber } : {}),
      },
    });

    const user = this.userFromSignUpResponse(data);
    if (!user) {
      throw new BadRequestException('Registration did not return a customer account');
    }

    // An empty identities array is Supabase's enumeration-safe response for an
    // account that already exists. Do not attempt to grant claims to its fake ID.
    if (Array.isArray(user.identities) && user.identities.length === 0) {
      throw new BadRequestException(
        `A user with this ${dto.method === 'email' ? 'email address' : 'phone number'} has already been registered. Please sign in instead.`,
      );
    }

    try {
      await this.adminRequest(`/users/${encodeURIComponent(user.id)}`, {
        app_metadata: {
          role: 'customer',
          branches: [],
          status: 'Active',
        },
      });
    } catch {
      // The verified role-less session can safely retry claim assignment via
      // POST /customer/bootstrap. Do not strand a customer after Supabase has
      // already created the identity and sent its code.
      console.warn('[auth] customer claims will be assigned during bootstrap', {
        id: user.id,
        method: dto.method,
      });
    }

    // With confirmation enabled, /signup returns no access token and sends the
    // customer to OTP verification. If confirmation is disabled, the mobile app
    // immediately signs in with the just-created credentials instead.
    return { needsConfirmation: typeof data.access_token !== 'string' };
  }

  async resendSignUpCode(dto: ResendSignUpCodeDto): Promise<void> {
    const identifier = this.normalizedIdentifier(dto.method, dto.identifier);
    await this.publicAuthRequest(
      '/resend',
      dto.method === 'email'
        ? { type: 'signup', email: identifier }
        : { type: 'sms', phone: identifier },
    );
  }

  private normalizedIdentifier(
    method: RegisterDto['method'],
    identifier: string,
  ): string {
    const normalized = identifier.trim();
    if (method === 'email') {
      const email = normalized.toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new BadRequestException('Enter a valid email address');
      }
      return email;
    }
    if (!/^\+639\d{9}$/.test(normalized)) {
      throw new BadRequestException('Enter a valid PH mobile number');
    }
    return normalized;
  }

  private userFromSignUpResponse(data: AuthJson): (AuthJson & { id: string }) | null {
    const candidate = this.isRecord(data.user) ? data.user : data;
    return typeof candidate.id === 'string'
      ? (candidate as AuthJson & { id: string })
      : null;
  }

  private isRecord(value: unknown): value is AuthJson {
    return typeof value === 'object' && value !== null;
  }

  private async publicAuthRequest(path: string, body: AuthJson): Promise<AuthJson> {
    const response = await fetch(`${this.authBaseUrl}${path}`, {
      method: 'POST',
      headers: {
        apikey: this.publishableKey,
        Authorization: `Bearer ${this.publishableKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    return this.readResponse(response, 'Authentication request failed');
  }

  private async adminRequest(path: string, body: AuthJson): Promise<AuthJson> {
    const response = await fetch(`${this.authBaseUrl}/admin${path}`, {
      method: 'PUT',
      headers: {
        apikey: this.serviceRoleKey,
        Authorization: `Bearer ${this.serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    return this.readResponse(response, 'Could not prepare the customer account');
  }

  private async readResponse(response: Response, fallback: string): Promise<AuthJson> {
    const data = (await response.json().catch(() => ({}))) as AuthJson;
    if (response.ok) return data;

    const message =
      (typeof data.msg === 'string' && data.msg) ||
      (typeof data.message === 'string' && data.message) ||
      (typeof data.error_description === 'string' && data.error_description) ||
      fallback;
    throw new BadRequestException(message);
  }
}
