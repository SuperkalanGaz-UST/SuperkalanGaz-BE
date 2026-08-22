import 'reflect-metadata';
import { Role } from '../auth/principal';
import { ROLES_KEY } from '../auth/roles.decorator';
import { UsersController } from './users.controller';

function rolesFor(handler: keyof UsersController): Role[] | undefined {
  return Reflect.getMetadata(ROLES_KEY, UsersController.prototype[handler]) as
    | Role[]
    | undefined;
}

describe('UsersController role access', () => {
  const allStaffRoles: Role[] = [
    'super-admin',
    'franchise-admin',
    'branch-owner',
    'branch-manager',
  ];

  it('allows every staff role to update its own profile', () => {
    expect(rolesFor('updateMe')).toEqual(allStaffRoles);
  });

  it('allows every staff role to change its own password', () => {
    expect(rolesFor('changeMyPassword')).toEqual(allStaffRoles);
  });

  it('keeps account-management endpoints under the FA/BO class restriction', () => {
    expect(Reflect.getMetadata(ROLES_KEY, UsersController)).toEqual([
      'franchise-admin',
      'branch-owner',
    ]);
    expect(rolesFor('list')).toBeUndefined();
    expect(rolesFor('create')).toBeUndefined();
    expect(rolesFor('update')).toBeUndefined();
    expect(rolesFor('remove')).toBeUndefined();
  });
});
