import 'reflect-metadata';
import { ROLES_KEY } from '../auth/roles.decorator';
import { StaffRegistrationController } from './staff-registration.controller';

describe('StaffRegistrationController authorization', () => {
  it('restricts the review queue to Franchise Administrators', () => {
    expect(Reflect.getMetadata(ROLES_KEY, StaffRegistrationController)).toEqual([
      'franchise-admin',
    ]);
  });
});
