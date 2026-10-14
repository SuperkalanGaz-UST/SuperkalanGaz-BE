import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CustomerBootstrapGuard } from '../auth/customer-bootstrap.guard';
import { Principal } from '../auth/principal';
import { CurrentPrincipal, Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { CustomerAddress } from './customer-address.entity';
import { CustomerAddressesService } from './customer-addresses.service';
import { SaveCustomerAddressDto } from './dto/save-customer-address.dto';

@Controller('customer')
export class CustomerAddressesController {
  constructor(private readonly addresses: CustomerAddressesService) {}

  @Post('bootstrap')
  @UseGuards(CustomerBootstrapGuard)
  async bootstrap(@CurrentPrincipal() principal: Principal) {
    await this.addresses.bootstrap(principal);
    return { role: 'customer' as const };
  }

  @Get('addresses')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('customer')
  async list(@CurrentPrincipal() principal: Principal) {
    return { addresses: (await this.addresses.list(principal)).map((address) => this.toRow(address)) };
  }

  @Post('addresses')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('customer')
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: SaveCustomerAddressDto,
  ) {
    return { address: this.toRow(await this.addresses.create(principal, dto)) };
  }

  @Patch('addresses/:id')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('customer')
  async update(
    @CurrentPrincipal() principal: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: SaveCustomerAddressDto,
  ) {
    return { address: this.toRow(await this.addresses.update(principal, id, dto)) };
  }

  private toRow(address: CustomerAddress) {
    return {
      id: address.id,
      label: address.label,
      full_address: address.fullAddress,
      province: address.province,
      city: address.city,
      barangay: address.barangay,
      street: address.street,
      landmark: address.landmark,
      contact_number: address.contactNumber,
      latitude: address.latitude,
      longitude: address.longitude,
      created_at: address.createdAt,
      updated_at: address.updatedAt,
    };
  }
}
