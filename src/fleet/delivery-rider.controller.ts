import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { Principal } from '../auth/principal';
import { CurrentPrincipal, Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { SetDeliveryRiderAvailabilityDto } from './dto/delivery-rider-invitation.dto';
import { UpdateDeliveryRiderLocationDto } from './dto/update-delivery-rider-location.dto';
import { FleetService } from './fleet.service';

@Controller('delivery-rider')
@UseGuards(AuthGuard, RolesGuard)
@Roles('driver')
export class DeliveryRiderController {
  constructor(private readonly fleet: FleetService) {}

  @Get('me')
  async me(@CurrentPrincipal() principal: Principal) {
    return this.fleet.deliveryRiderDashboard(principal);
  }

  @Post('availability')
  async availability(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: SetDeliveryRiderAvailabilityDto,
  ) {
    await this.fleet.setDeliveryRiderAvailability(principal, dto.available);
    return this.fleet.deliveryRiderDashboard(principal);
  }

  @Post('location')
  async location(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: UpdateDeliveryRiderLocationDto,
  ) {
    return this.fleet.updateDeliveryRiderOperationalLocation(principal, dto);
  }
}
