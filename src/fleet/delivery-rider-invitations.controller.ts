import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { Principal } from '../auth/principal';
import {
  AllowPendingInvitation,
  CurrentPrincipal,
  Roles,
} from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { DeliveryRiderInvitationsService } from './delivery-rider-invitations.service';
import { CreateDeliveryRiderInvitationDto } from './dto/create-delivery-rider-invitation.dto';
import {
  CreateDeliveryRiderAccountDto,
  CreateDeliveryRiderSessionAccountDto,
  DeliveryRiderInvitationTokenDto,
  ListDeliveryRiderInvitationsQuery,
  RevokeDeliveryRiderInvitationDto,
  VerifyDeliveryRiderSessionMobileDto,
} from './dto/delivery-rider-invitation.dto';

@Controller('delivery-rider-invitations')
export class DeliveryRiderInvitationsController {
  constructor(private readonly invitations: DeliveryRiderInvitationsService) {}

  /** Public only because possession of the high-entropy, expiring token is required. */
  @Get('acceptance')
  async acceptance(@Query() dto: DeliveryRiderInvitationTokenDto) {
    return this.invitations.acceptance(dto.token);
  }

  @Post('account')
  @HttpCode(200)
  async createAccount(@Body() dto: CreateDeliveryRiderAccountDto) {
    await this.invitations.createAccount(dto.token, dto.password);
    return { message: 'Delivery Rider account password created' };
  }

  @Post('accept')
  @HttpCode(200)
  async accept(@Body() dto: DeliveryRiderInvitationTokenDto) {
    await this.invitations.accept(dto.token);
    return { message: 'Delivery Rider account activated' };
  }

  /** Mirrors FA web registration after Supabase verifies the invitation email. */
  @Get('session/acceptance')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('driver')
  @AllowPendingInvitation()
  async sessionAcceptance(@CurrentPrincipal() principal: Principal) {
    return this.invitations.acceptanceForSession(principal);
  }

  @Post('session/account')
  @HttpCode(200)
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('driver')
  @AllowPendingInvitation()
  async createSessionAccount(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: CreateDeliveryRiderSessionAccountDto,
  ) {
    await this.invitations.createAccountForSession(principal, dto.password);
    return { message: 'Delivery Rider account password created' };
  }

  @Post('session/mobile-code')
  @HttpCode(200)
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('driver')
  @AllowPendingInvitation()
  async sessionMobileCode(@CurrentPrincipal() principal: Principal) {
    await this.invitations.sendMobileCodeForSession(principal);
    return { message: 'Verification code sent' };
  }

  @Get('session/mobile-verification')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('driver')
  @AllowPendingInvitation()
  async sessionMobileVerification(@CurrentPrincipal() principal: Principal) {
    return this.invitations.mobileVerificationForSession(principal);
  }

  @Post('session/verify-mobile')
  @HttpCode(200)
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('driver')
  @AllowPendingInvitation()
  async verifySessionMobile(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: VerifyDeliveryRiderSessionMobileDto,
  ) {
    await this.invitations.verifyMobileForSession(principal, dto.code);
    return { message: 'Mobile number verified and Delivery Rider account activated' };
  }

  @Post('session/complete-placeholder-mobile-verification')
  @HttpCode(200)
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('driver')
  @AllowPendingInvitation()
  async completePlaceholderMobileVerification(
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.invitations.completePlaceholderMobileVerificationForSession(principal);
    return {
      message: 'Temporary mobile verification placeholder completed',
    };
  }

  @Post('session/accept')
  @HttpCode(200)
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('driver')
  @AllowPendingInvitation()
  async acceptSession(@CurrentPrincipal() principal: Principal) {
    await this.invitations.acceptForSession(principal);
    return { message: 'Delivery Rider account activated' };
  }

  @Get()
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('branch-owner')
  async list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListDeliveryRiderInvitationsQuery,
  ) {
    return { invitations: await this.invitations.list(principal, query) };
  }

  @Post()
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('branch-owner')
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: CreateDeliveryRiderInvitationDto,
  ) {
    return { invitation: await this.invitations.create(principal, dto) };
  }

  @Post(':id/resend')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('branch-owner')
  async resend(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return { invitation: await this.invitations.resend(principal, id) };
  }

  @Patch(':id/revoke')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('branch-owner')
  async revoke(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RevokeDeliveryRiderInvitationDto,
  ) {
    return {
      invitation: await this.invitations.revoke(principal, id, dto.reason),
    };
  }
}
