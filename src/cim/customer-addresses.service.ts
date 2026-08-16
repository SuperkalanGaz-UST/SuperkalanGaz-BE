import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { Principal } from '../auth/principal';
import { GoTrueAdminService } from '../users/gotrue-admin.service';
import { CustomerAddress } from './customer-address.entity';
import { SaveCustomerAddressDto } from './dto/save-customer-address.dto';

@Injectable()
export class CustomerAddressesService {
  constructor(
    @InjectRepository(CustomerAddress)
    private readonly addresses: Repository<CustomerAddress>,
    private readonly goTrue: GoTrueAdminService,
  ) {}

  /**
   * Promotes a verified, role-less Supabase signup to the customer role. The
   * service-role API is the only writer of app_metadata authorization claims.
   */
  async bootstrap(principal: Principal): Promise<void> {
    const user = await this.goTrue.getUser(principal.userId);
    if (!user) throw new NotFoundException('Customer account not found');

    const currentRole = user.app_metadata?.role;
    if (currentRole !== undefined && currentRole !== 'customer') {
      throw new BadRequestException('This account is not a customer account');
    }

    await this.goTrue.updateUser(principal.userId, {
      app_metadata: {
        ...(user.app_metadata ?? {}),
        role: 'customer',
        branches: [],
        status: 'Active',
      },
    });
  }

  list(principal: Principal): Promise<CustomerAddress[]> {
    return this.addresses.find({
      where: { authUserId: principal.userId, deletedAt: IsNull() },
      order: { createdAt: 'ASC' },
      take: 20,
    });
  }

  async create(principal: Principal, dto: SaveCustomerAddressDto): Promise<CustomerAddress> {
    this.assertCoordinatePair(dto);
    const existingCount = await this.addresses.count({
      where: { authUserId: principal.userId, deletedAt: IsNull() },
    });
    if (existingCount >= 20) {
      throw new BadRequestException('A customer can save up to 20 delivery addresses');
    }
    const now = new Date();
    const address = this.addresses.create({
      authUserId: principal.userId,
      ...this.values(dto),
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
    return this.addresses.save(address);
  }

  async update(
    principal: Principal,
    id: string,
    dto: SaveCustomerAddressDto,
  ): Promise<CustomerAddress> {
    this.assertCoordinatePair(dto);
    const address = await this.addresses.findOne({
      where: { id, authUserId: principal.userId, deletedAt: IsNull() },
    });
    // Returning the same result for missing and out-of-owner-scope IDs prevents
    // one customer from probing whether another customer's address exists.
    if (!address) throw new NotFoundException('Saved address not found');

    Object.assign(address, this.values(dto), { updatedAt: new Date() });
    return this.addresses.save(address);
  }

  private values(dto: SaveCustomerAddressDto) {
    const street = dto.street.trim();
    const barangay = dto.barangay.trim();
    const city = dto.city.trim();
    const province = dto.province.trim();
    return {
      label: dto.label.trim(),
      fullAddress: `${street}, ${barangay}, ${city}, ${province}`,
      province,
      city,
      barangay,
      street,
      landmark: dto.landmark?.trim() || null,
      contactNumber: dto.contactNumber,
      latitude: dto.latitude ?? null,
      longitude: dto.longitude ?? null,
    };
  }

  private assertCoordinatePair(dto: SaveCustomerAddressDto): void {
    if ((dto.latitude === undefined) !== (dto.longitude === undefined)) {
      throw new BadRequestException('latitude and longitude must be supplied together');
    }
  }
}
