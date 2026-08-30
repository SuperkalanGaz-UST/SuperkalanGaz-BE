import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Thin client for the Supabase Auth (GoTrue) Admin REST API. In this system ALL
 * identity lives in auth.users: credentials/email as first-class fields and the
 * CRM claims (role, branch scope, status, display fields) in `app_metadata`.
 * `app_metadata` is writable ONLY through this service-role client — never by the
 * signed-in user (unlike `user_metadata`) — so it is the safe home for the
 * tenancy scope the guards trust (AGENTS.md §5, §6). There is NO public.profiles
 * mirror table. We call GoTrue with plain fetch rather than the Supabase JS SDK:
 * AGENTS.md §4 bans the SDK because its data paths (PostgREST) would bypass our
 * branch-scoped guards — auth administration is the one concern that legitimately
 * must go through Supabase's own service.
 */
interface GoTrueUserAttrs {
  email?: string;
  phone?: string;
  password?: string;
  email_confirm?: boolean;
  phone_confirm?: boolean;
  user_metadata?: Record<string, unknown>;
  app_metadata?: Record<string, unknown>;
  ban_duration?: string;
}

/** A user record as returned by the GoTrue Admin API (the fields we consume). */
export interface GoTrueUser {
  id: string;
  email: string | null;
  phone?: string | null;
  app_metadata: Record<string, unknown>;
  user_metadata: Record<string, unknown>;
  banned_until: string | null;
  created_at: string;
  last_sign_in_at?: string | null;
  invited_at?: string | null;
  confirmation_sent_at?: string | null;
  confirmed_at?: string | null;
  email_confirmed_at?: string | null;
  phone_confirmed_at?: string | null;
}

@Injectable()
export class GoTrueAdminService {
  private readonly authUrl: string;
  private readonly baseUrl: string;
  private readonly serviceKey: string;
  private readonly publicKey: string;

  constructor(config: ConfigService) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL').replace(/\/$/, '');
    this.authUrl = `${supabaseUrl}/auth/v1`;
    this.baseUrl = `${supabaseUrl}/auth/v1/admin`;
    this.serviceKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.publicKey = config.get<string>('SUPABASE_ANON_KEY') || this.serviceKey;
  }

  /** Creates an auth user; CRM claims are passed in `app_metadata`. */
  async createUser(attrs: GoTrueUserAttrs): Promise<{ id: string }> {
    const user = await this.request('POST', '/users', attrs);
    return { id: user.id as string };
  }

  /**
   * Sends Supabase Auth's single-use invitation email. Only non-sensitive
   * display data goes in user_metadata; protected CRM claims are written in a
   * separate Admin API call immediately afterwards.
   */
  async inviteUser(
    email: string,
    displayName: string,
    redirectTo: string,
  ): Promise<GoTrueUser> {
    const query = new URLSearchParams({ redirect_to: redirectTo });
    const user = await this.request(
      'POST',
      `/invite?${query.toString()}`,
      { email, data: { display_name: displayName } },
      this.authUrl,
    );
    return user as unknown as GoTrueUser;
  }

  /**
   * Sends a single-use link to an existing confirmed identity. Supabase rejects
   * a second `/invite` call after email confirmation, so a revoked invitation
   * must continue through the existing Auth row instead of creating a duplicate.
   */
  async sendExistingUserLink(email: string, redirectTo: string): Promise<void> {
    const query = new URLSearchParams({ redirect_to: redirectTo });
    await this.authRequest('POST', `/otp?${query.toString()}`, {
      email,
      create_user: false,
    });
  }

  /** Fetches a single user by id, or null if GoTrue has no such user. */
  async getUser(id: string): Promise<GoTrueUser | null> {
    const user = await this.request('GET', `/users/${id}`).catch((err) => {
      // A missing user surfaces as a 4xx; treat it as "not found", not an error.
      if (err instanceof BadRequestException) return null;
      throw err;
    });
    return user ? (user as unknown as GoTrueUser) : null;
  }

  /**
   * Every auth user, paged through the Admin API (which caps each page). Callers
   * filter/scope in memory — with the profiles table gone there is no server-side
   * claim query (AGENTS.md §6). Fine at franchise-staff scale.
   */
  async listUsers(): Promise<GoTrueUser[]> {
    const perPage = 200;
    const all: GoTrueUser[] = [];
    for (let page = 1; ; page++) {
      const data = await this.request('GET', `/users?page=${page}&per_page=${perPage}`);
      const batch = (data.users as GoTrueUser[]) ?? [];
      all.push(...batch);
      if (batch.length < perPage) break;
    }
    return all;
  }

  /** First user whose email matches (case-insensitive), or null. */
  async findByEmail(email: string): Promise<GoTrueUser | null> {
    const target = email.trim().toLowerCase();
    const users = await this.listUsers();
    return users.find((u) => (u.email ?? '').toLowerCase() === target) ?? null;
  }

  /** Updates auth-owned fields (email / password / ban) and/or metadata. */
  async updateUser(id: string, attrs: GoTrueUserAttrs): Promise<void> {
    await this.request('PUT', `/users/${id}`, attrs);
  }

  /**
   * Blocks sign-in without deleting the identity — the auth-side of a soft
   * delete (AGENTS.md §3.2: never hard-delete). 100 years ≈ permanent.
   */
  async banUser(id: string): Promise<void> {
    await this.updateUser(id, { ban_duration: '876000h' });
  }

  /** Re-enables a retained auth identity; no auth row is deleted. */
  async unbanUser(id: string): Promise<void> {
    await this.updateUser(id, { ban_duration: 'none' });
  }

  /** Sends an SMS OTP only for an identity already created by the invitation. */
  async requestPhoneOtp(phone: string): Promise<void> {
    await this.authRequest('POST', '/otp', { phone, create_user: false });
  }

  /** Verifies the phone and returns the Auth identity that consumed the code. */
  async verifyPhoneOtp(phone: string, token: string): Promise<{ userId: string }> {
    const result = await this.authRequest('POST', '/verify', {
      phone,
      token,
      type: 'sms',
    });
    const user = result.user;
    if (
      !user ||
      typeof user !== 'object' ||
      typeof (user as Record<string, unknown>).id !== 'string'
    ) {
      throw new BadRequestException('The mobile verification response was invalid');
    }
    return { userId: (user as Record<string, unknown>).id as string };
  }

  private async authRequest(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request(method, path, body, this.authUrl, this.publicKey);
  }

  private async request(
    method: string,
    path: string,
    body?: GoTrueUserAttrs | Record<string, unknown>,
    baseUrl = this.baseUrl,
    authKey = this.serviceKey,
  ): Promise<Record<string, unknown>> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      signal: AbortSignal.timeout(8_000),
      headers: {
        apikey: authKey,
        Authorization: `Bearer ${authKey}`,
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      // Surface duplicate-email and validation messages to the UI, like the
      // legacy Next.js route handlers did.
      const message =
        (data.msg as string) ??
        (data.message as string) ??
        (data.error_description as string) ??
        `Auth admin request failed (${res.status})`;
      throw new BadRequestException(message);
    }
    return data;
  }
}
