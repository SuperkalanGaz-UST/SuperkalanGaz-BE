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
    const now = Date.now();
    const matches = users.filter((user) => {
      const { username: savedUsername, role, status } = user.app_metadata;
      return typeof savedUsername === 'string' &&
        savedUsername.trim().toLowerCase() === normalized &&
        STAFF_ROLES.includes(String(role)) &&
        (status === undefined || status === 'Active') &&
        !(user.banned_until && Date.parse(user.banned_until) > now);
    });
    // Retained ineligible accounts cannot block a staff login. Multiple eligible
    // matches still fail closed instead of guessing which account to authenticate.
    return matches.length === 1 ? matches[0].email : null;
  }
}
