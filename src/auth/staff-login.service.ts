import { Injectable, UnauthorizedException } from '@nestjs/common';
import { GoTrueAdminService, GoTrueSessionTokens } from '../users/gotrue-admin.service';

const STAFF_ROLES = ['super-admin', 'franchise-admin', 'branch-owner', 'branch-manager'];

/** Resolves protected usernames internally; no public endpoint reveals an account email. */
@Injectable()
export class StaffLoginService {
  constructor(private readonly goTrue: GoTrueAdminService) {}

  async signIn(username: string, password: string): Promise<GoTrueSessionTokens> {
    const email = await this.resolveEmail(username);
    if (!email) throw new UnauthorizedException('Invalid username or password');
    try {
      return await this.goTrue.signInWithPassword(email, password);
    } catch {
      throw new UnauthorizedException('Invalid username or password');
    }
  }

  private async resolveEmail(username: string): Promise<string | null> {
    const normalized = username.trim().toLowerCase();
    const users = await this.goTrue.listUsers();
    const matches = users.filter((user) =>
      typeof user.app_metadata.username === 'string' &&
      user.app_metadata.username.trim().toLowerCase() === normalized,
    );
    // Legacy duplicate metadata must never pick an arbitrary identity. Only an
    // exact, unambiguous protected username may reach the password exchange.
    if (matches.length !== 1) return null;
    const user = matches[0];
    if (
      !STAFF_ROLES.includes(String(user.app_metadata.role)) ||
      (user.app_metadata.status !== undefined && user.app_metadata.status !== 'Active') ||
      (user.banned_until && new Date(user.banned_until).getTime() > Date.now())
    ) return null;
    return user.email;
  }
}
