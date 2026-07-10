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
  password?: string;
  email_confirm?: boolean;
  user_metadata?: Record<string, unknown>;
  app_metadata?: Record<string, unknown>;
  ban_duration?: string;
}

/** A user record as returned by the GoTrue Admin API (the fields we consume). */
export interface GoTrueUser {
  id: string;
  email: string | null;
  app_metadata: Record<string, unknown>;
  user_metadata: Record<string, unknown>;
  banned_until: string | null;
  created_at: string;
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

  /** Creates an auth user; CRM claims are passed in `app_metadata`. */
  async createUser(attrs: GoTrueUserAttrs): Promise<{ id: string }> {
    const user = await this.request('POST', '/users', attrs);
    return { id: user.id as string };
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

  private async request(
    method: string,
    path: string,
    body?: GoTrueUserAttrs,
  ): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        apikey: this.serviceKey,
        Authorization: `Bearer ${this.serviceKey}`,
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
