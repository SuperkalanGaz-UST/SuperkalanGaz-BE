import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Thin client for the Supabase Auth (GoTrue) Admin REST API. Identity records
 * (credentials, email) live in auth.users and can only be managed through this
 * API. We call it with plain fetch rather than the Supabase JS SDK: AGENTS.md
 * §4 bans the SDK because its data paths (PostgREST) would bypass our
 * branch-scoped guards — auth administration is the one concern that
 * legitimately must go through Supabase's own service.
 */
interface GoTrueUserAttrs {
  email?: string;
  password?: string;
  email_confirm?: boolean;
  user_metadata?: Record<string, unknown>;
  ban_duration?: string;
}

@Injectable()
export class GoTrueAdminService {
  private readonly baseUrl: string;
  private readonly serviceKey: string;

  constructor(config: ConfigService) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL').replace(/\/$/, '');
    this.baseUrl = `${supabaseUrl}/auth/v1/admin`;
    this.serviceKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
  }

  /** Creates an auth user; the on_auth_user_created trigger mirrors metadata into public.profiles. */
  async createUser(attrs: GoTrueUserAttrs): Promise<{ id: string }> {
    const user = await this.request('POST', '/users', attrs);
    return { id: user.id as string };
  }

  /** Updates auth-owned fields (email / password / ban) for an existing user. */
  async updateUser(id: string, attrs: GoTrueUserAttrs): Promise<void> {
    await this.request('PUT', `/users/${id}`, attrs);
  }

  /**
   * Blocks sign-in without deleting the identity — the auth-side half of a
   * soft delete (AGENTS.md §3.2: never hard-delete). 100 years ≈ permanent.
   */
  async banUser(id: string): Promise<void> {
    await this.updateUser(id, { ban_duration: '876000h' });
  }

  private async request(
    method: string,
    path: string,
    body: GoTrueUserAttrs,
  ): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        apikey: this.serviceKey,
        Authorization: `Bearer ${this.serviceKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
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
