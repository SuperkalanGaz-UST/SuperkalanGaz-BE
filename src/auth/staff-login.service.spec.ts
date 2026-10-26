import { UnauthorizedException } from '@nestjs/common';
import { GoTrueAdminService, GoTrueUser } from '../users/gotrue-admin.service';
import { StaffLoginService } from './staff-login.service';

describe('StaffLoginService', () => {
  const user: GoTrueUser = {
    id: 'staff-1', email: 'verified@example.com', app_metadata: {
      username: 'new.name', role: 'branch-manager', status: 'Active',
    }, user_metadata: {}, banned_until: null, created_at: '2026-01-01T00:00:00Z',
  };
  const tokens = { access_token: 'password-authorized-access', refresh_token: 'password-authorized-refresh' };
  let goTrue: jest.Mocked<Pick<GoTrueAdminService, 'listUsers' | 'signInWithPassword'>>;
  let service: StaffLoginService;

  beforeEach(() => {
    goTrue = { listUsers: jest.fn().mockResolvedValue([user]), signInWithPassword: jest.fn().mockResolvedValue(tokens) };
    service = new StaffLoginService(goTrue as unknown as GoTrueAdminService);
  });

  it('authenticates a renamed username with the existing account email and password', async () => {
    expect(await service.signIn(' NEW.NAME ', 'secret')).toEqual(tokens);
    expect(goTrue.signInWithPassword).toHaveBeenCalledWith('verified@example.com', 'secret');
  });

  it('does not accept the old username or user-editable metadata as an alias', async () => {
    goTrue.listUsers.mockResolvedValue([{ ...user, user_metadata: { username: 'old.name' } }]);
    await expect(service.signIn('old.name', 'secret')).rejects.toThrow('Invalid username or password');
    expect(goTrue.signInWithPassword).not.toHaveBeenCalled();
  });

  it.each(['super-admin', 'franchise-admin', 'branch-owner', 'branch-manager'])(
    'supports the %s website persona', async (role) => {
      goTrue.listUsers.mockResolvedValue([{ ...user, app_metadata: { ...user.app_metadata, role } }]);
      expect(await service.signIn('new.name', 'secret')).toEqual(tokens);
    },
  );

  it.each([
    { role: 'customer' }, { role: 'driver' }, { status: 'Pending' }, { status: 'Inactive' },
  ])('rejects an unauthorized persona/status %p', async (metadata) => {
    goTrue.listUsers.mockResolvedValue([{ ...user, app_metadata: { ...user.app_metadata, ...metadata } }]);
    await expect(service.signIn('new.name', 'secret')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(goTrue.signInWithPassword).not.toHaveBeenCalled();
  });

  it('rejects banned identities and ambiguous legacy usernames', async () => {
    goTrue.listUsers.mockResolvedValue([{ ...user, banned_until: '2126-01-01T00:00:00Z' }]);
    await expect(service.signIn('new.name', 'secret')).rejects.toBeInstanceOf(UnauthorizedException);
    goTrue.listUsers.mockResolvedValue([user, { ...user, id: 'staff-2' }]);
    await expect(service.signIn('new.name', 'secret')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(goTrue.signInWithPassword).not.toHaveBeenCalled();
  });

  it('returns a generic credential error without revealing the resolved email', async () => {
    goTrue.signInWithPassword.mockRejectedValue(new Error('verified@example.com rejected'));
    await expect(service.signIn('new.name', 'wrong')).rejects.toThrow('Invalid username or password');
  });
});
