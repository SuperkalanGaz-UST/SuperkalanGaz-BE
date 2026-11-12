import { ConfigService } from '@nestjs/config';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { EntityManager, Repository } from 'typeorm';
import { BranchOwnerInvitationsService } from './branch-owner-invitations.service';
import { Branch } from './branch.entity';
import { GoTrueAdminService, GoTrueUser } from '../users/gotrue-admin.service';
import { GovernanceAuditService } from '../governance/governance-audit.service';
import { Principal } from '../auth/principal';

const branch = { id: 'branch-a', name: 'Branch A', ownerId: 'owner-a', status: 'active' };
const inviter: Principal = { userId: 'fa-a', role: 'franchise-admin', branchIds: [], branches: [] };
const invitee: Principal = { userId: 'owner-a', role: 'branch-owner', email: 'owner@example.invalid', branchIds: ['branch-a'], branches: ['Branch A'] };
function pending(): GoTrueUser {
  return {
    id: 'owner-a', email: invitee.email!, user_metadata: {}, banned_until: null,
    created_at: new Date().toISOString(), email_confirmed_at: new Date().toISOString(),
    app_metadata: { role: 'branch-owner', status: 'Pending', branch_owner_invitation: true,
      invited_by: 'fa-a', invitation_branch_id: 'branch-a', branch_ids: ['branch-a'], branches: ['Branch A'],
      invitation_expires_at: new Date(Date.now() + 3600000).toISOString() },
  };
}
function setup() {
  const current = pending();
  const manager = { findOne: jest.fn().mockResolvedValue(branch) };
  const repository = {
    findOne: jest.fn().mockResolvedValue(branch),
    manager: { transaction: (work: (m: EntityManager) => Promise<unknown>) => work(manager as unknown as EntityManager) },
  };
  const auth = { findByEmail: jest.fn().mockResolvedValue(null),
    inviteUser: jest.fn().mockResolvedValue({ ...current, app_metadata: {}, email_confirmed_at: null }),
    getUser: jest.fn().mockResolvedValue(current), updateUser: jest.fn().mockResolvedValue(undefined),
    banUser: jest.fn().mockResolvedValue(undefined), sendExistingUserLink: jest.fn().mockResolvedValue(undefined),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new BranchOwnerInvitationsService(repository as unknown as Repository<Branch>, auth as unknown as GoTrueAdminService,
    new ConfigService({ WEB_ORIGIN: 'http://localhost:3000' }), audit as unknown as GovernanceAuditService);
  return { service, auth, audit, manager, repository, current };
}

describe('Branch Owner invitation lifecycle', () => {
  it('sends the Auth invitation without creating, returning, or emailing a password', async () => {
    const { service, auth } = setup();
    const result = await service.inviteNew(inviter, 'New Owner', 'OWNER@example.invalid', '+639171234567');
    expect(auth.inviteUser).toHaveBeenCalledWith('owner@example.invalid', 'New Owner', 'http://localhost:3000/?invitation=branch-owner');
    expect(auth.updateUser).toHaveBeenCalledWith('owner-a', { app_metadata: expect.objectContaining({ role: 'branch-owner', status: 'Pending', branch_ids: [], invited_by: 'fa-a' }) });
    expect(result.app_metadata.status).toBe('Pending');
    expect(JSON.stringify(auth.updateUser.mock.calls)).not.toContain('password');
  });

  it('rejects an existing email before requesting mail', async () => {
    const { service, auth, current } = setup();
    auth.findByEmail.mockResolvedValue(current);
    await expect(service.inviteNew(inviter, 'Owner', current.email!)).rejects.toBeInstanceOf(ConflictException);
    expect(auth.inviteUser).not.toHaveBeenCalled();
  });

  it('reports SMTP errors and never marks an unprotected invitation ready', async () => {
    const { service, auth } = setup();
    auth.inviteUser.mockRejectedValue(new Error('Email sending unavailable'));
    await expect(service.inviteNew(inviter, 'Owner', 'owner@example.invalid')).rejects.toThrow('Email sending unavailable');
    expect(auth.updateUser).not.toHaveBeenCalled();
  });

  it('bans the retained invitation if protected claim initialization fails', async () => {
    const { service, auth } = setup();
    auth.updateUser.mockRejectedValue(new Error('Claims unavailable'));
    await expect(service.inviteNew(inviter, 'Owner', 'owner@example.invalid')).rejects.toThrow('Claims unavailable');
    expect(auth.banUser).toHaveBeenCalledWith('owner-a');
  });

  it('sets the verified invitee password and activates only their live assigned branch', async () => {
    const { service, auth, audit, manager } = setup();
    await service.accept(invitee, 'ChosenPassword1');
    expect(manager.findOne).toHaveBeenCalledWith(Branch, expect.objectContaining({ where: { id: 'branch-a', ownerId: 'owner-a', status: 'active' }, lock: { mode: 'pessimistic_write' } }));
    expect(auth.updateUser).toHaveBeenCalledWith('owner-a', { password: 'ChosenPassword1', app_metadata: expect.objectContaining({ status: 'Active', branch_ids: ['branch-a'], invited_by: 'fa-a' }) });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'branch-owner-invitation-accepted', branchId: 'branch-a' }), manager);
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain('ChosenPassword1');
  });

  it('makes acceptance retry idempotent without resetting the chosen password', async () => {
    const { service, auth, current, audit } = setup();
    current.app_metadata.status = 'Active';
    current.app_metadata.invitation_accepted_at = new Date().toISOString();
    await service.accept(invitee, 'AnotherPassword2');
    expect(auth.updateUser).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it.each(['expired', 'unverified', 'inactive', 'banned', 'wrong-role', 'wrong-email', 'not-an-invitation'])('rejects %s invitations without setting a password', async (scenario) => {
    const { service, current, auth } = setup();
    if (scenario === 'expired') current.app_metadata.invitation_expires_at = new Date(0).toISOString();
    if (scenario === 'unverified') current.email_confirmed_at = null;
    if (scenario === 'inactive') current.app_metadata.status = 'Inactive';
    if (scenario === 'banned') current.banned_until = '2099-01-01T00:00:00Z';
    if (scenario === 'wrong-role') current.app_metadata.role = 'branch-manager';
    if (scenario === 'wrong-email') current.email = 'other@example.invalid';
    if (scenario === 'not-an-invitation') current.app_metadata.branch_owner_invitation = false;
    await expect(service.accept(invitee, 'ChosenPassword1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(auth.updateUser).not.toHaveBeenCalled();
  });

  it('rejects reassignment even if the old JWT still claims the branch', async () => {
    const { service, manager, auth } = setup();
    manager.findOne.mockResolvedValue(null);
    await expect(service.accept(invitee, 'ChosenPassword1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(auth.updateUser).not.toHaveBeenCalled();
  });

  it('rejects a branch absent from the protected scope', async () => {
    const { service, auth } = setup();
    await expect(service.accept({ ...invitee, branchIds: [] }, 'ChosenPassword1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(auth.updateUser).not.toHaveBeenCalled();
  });

  it('resends a verified pending setup link with fresh expiry and unchanged scope', async () => {
    const { service, auth, audit } = setup();
    await service.resend(inviter, 'branch-a');
    expect(auth.sendExistingUserLink).toHaveBeenCalledWith(invitee.email, 'http://localhost:3000/?invitation=branch-owner');
    expect(auth.updateUser).toHaveBeenCalledWith('owner-a', { app_metadata: expect.objectContaining({ status: 'Pending', branch_ids: ['branch-a'] }) });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'branch-owner-invitation-resent' }));
  });

  it('does not resend an invitation for an already active owner', async () => {
    const { service, current, auth } = setup();
    current.app_metadata.status = 'Active';
    await expect(service.resend(inviter, 'branch-a')).rejects.toBeInstanceOf(ConflictException);
    expect(auth.sendExistingUserLink).not.toHaveBeenCalled();
    expect(auth.inviteUser).not.toHaveBeenCalled();
  });
});
