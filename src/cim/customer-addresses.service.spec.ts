import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { Principal } from '../auth/principal';
import { GoTrueAdminService, GoTrueUser } from '../users/gotrue-admin.service';
import { CustomerAddress } from './customer-address.entity';
import { CustomerAddressesService } from './customer-addresses.service';
import { SaveCustomerAddressDto } from './dto/save-customer-address.dto';

describe('CustomerAddressesService', () => {
  const principal: Principal = {
    userId: '48cf2b62-385e-409d-bdf0-e0466c4db356',
    role: 'customer',
    branches: [],
    branchIds: [],
  };

  const input: SaveCustomerAddressDto = {
    label: ' Home ',
    province: ' Metro Manila ',
    city: ' Las Piñas ',
    barangay: ' Talon Dos ',
    street: ' 12 Sampaguita St ',
    landmark: ' Near the school ',
    contactNumber: '+639171234567',
    latitude: 14.4445,
    longitude: 120.9939,
  };

  const makeService = (found: CustomerAddress | null = null) => {
    const repository = {
      find: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findOne: jest.fn().mockResolvedValue(found),
      create: jest.fn((value: Partial<CustomerAddress>) => value as CustomerAddress),
      save: jest.fn((value: CustomerAddress) => Promise.resolve({ ...value, id: value.id ?? 'address-1' })),
    } as unknown as jest.Mocked<Repository<CustomerAddress>>;
    const goTrue = {
      getUser: jest.fn(),
      updateUser: jest.fn(),
    } as unknown as jest.Mocked<GoTrueAdminService>;
    return { service: new CustomerAddressesService(repository, goTrue), repository, goTrue };
  };

  it('lists only live addresses owned by the authenticated customer', async () => {
    const { service, repository } = makeService();

    await service.list(principal);

    expect(repository.find).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ authUserId: principal.userId, deletedAt: expect.anything() }),
      take: 20,
    }));
  });

  it('creates an owned address and derives the canonical display address', async () => {
    const { service, repository } = makeService();

    const saved = await service.create(principal, input);

    expect(saved.authUserId).toBe(principal.userId);
    expect(saved.label).toBe('Home');
    expect(saved.fullAddress).toBe('12 Sampaguita St, Talon Dos, Las Piñas, Metro Manila');
    expect(repository.save).toHaveBeenCalledTimes(1);
  });

  it('requires coordinates to be supplied as a complete pair', async () => {
    const { service, repository } = makeService();

    await expect(service.create(principal, { ...input, longitude: undefined }))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('updates only an address found inside the caller ownership scope', async () => {
    const existing = { id: 'address-1', authUserId: principal.userId } as CustomerAddress;
    const { service, repository } = makeService(existing);

    await service.update(principal, existing.id, input);

    expect(repository.findOne).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: existing.id,
        authUserId: principal.userId,
        deletedAt: expect.anything(),
      }),
    });
    expect(repository.save).toHaveBeenCalledWith(expect.objectContaining({ id: existing.id }));
  });

  it('does not reveal an address outside the caller ownership scope', async () => {
    const { service, repository } = makeService(null);

    await expect(service.update(principal, 'other-address', input))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('writes the customer role through the server-only auth admin boundary', async () => {
    const { service, goTrue } = makeService();
    const user = {
      id: principal.userId,
      email: 'customer@example.com',
      app_metadata: { locale: 'en' },
      user_metadata: { account_type: 'household' },
      banned_until: null,
      created_at: '2026-08-15T00:00:00.000Z',
    } satisfies GoTrueUser;
    goTrue.getUser.mockResolvedValue(user);

    await service.bootstrap(principal);

    expect(goTrue.updateUser).toHaveBeenCalledWith(principal.userId, {
      app_metadata: {
        locale: 'en',
        role: 'customer',
        branch_ids: [],
        branches: [],
        status: 'Active',
        account_type: 'household',
      },
    });
  });
});
