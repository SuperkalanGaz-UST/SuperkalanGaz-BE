import { BranchOwnerInvitationsService } from './branch-owner-invitations.service';
import { AcceptBranchOwnerInvitationDto } from './dto/accept-branch-owner-invitation.dto';
import { BranchGeocodingService } from './branch-geocoding.service';
import { LocateBranchAddressDto } from './dto/locate-branch-address.dto';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { Principal } from '../auth/principal';
import { AllowPendingInvitation, CurrentPrincipal, Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import {
  AssignedBranchRow,
  BranchRow,
  BranchesService,
  CreateBranchResult,
} from './branches.service';
import { CreateBranchDto } from './dto/create-branch.dto';
import { UpdateBranchDto } from './dto/update-branch.dto';

/**
 * Branch registry. Registry reads and writes remain Franchise Administrator
 * actions (AGENTS.md §7). The handler-level staff override exposes only
 * assigned branch configuration and is UUID-scoped from the verified
 * Principal in the service layer.
 */
@Controller('branches')
@UseGuards(AuthGuard, RolesGuard)
@Roles('franchise-admin')
export class BranchesController {
  constructor(
    private readonly branches: BranchesService,
    private readonly geocoding: BranchGeocodingService,
    private readonly ownerInvitations: BranchOwnerInvitationsService,
  ) {}

  /**
   * Branch configuration for the authenticated BO/BM assigned scope.
   * This handler-level role intentionally overrides the FA-only registry role
   * on the controller; service-layer UUID scoping remains the data boundary.
   */
  @Get('assigned')
  @Roles('branch-owner', 'branch-manager')
  async assigned(
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ branches: AssignedBranchRow[] }> {
    const branches = await this.branches.listAssigned(principal);
    return { branches };
  }

  @Get()
  async list(): Promise<{ branches: BranchRow[] }> {
    const branches = await this.branches.list();
    return { branches };
  }

  /** Read-only active branch list for the customer mobile order flow. */
  @Get('public')
  @Roles('franchise-admin', 'branch-owner', 'branch-manager', 'customer')
  async publicList(): Promise<{ branches: BranchRow[] }> {
    const branches = await this.branches.list();
    return { branches: branches.filter((branch) => branch.status === 'active') };
  }

  /** User-triggered lookup only; inherits the Franchise Administrator guard. */
  @Post('locate-address')
  locateAddress(@Body() dto: LocateBranchAddressDto) {
    return this.geocoding.locate(dto);
  }

  @Post()
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: CreateBranchDto,
  ): Promise<CreateBranchResult> {
    return this.branches.create(principal, dto);
  }

  @Post('owner-invitations/accept')
  @Roles('branch-owner')
  @AllowPendingInvitation()
  async acceptOwnerInvitation(@CurrentPrincipal() principal: Principal, @Body() dto: AcceptBranchOwnerInvitationDto) {
    await this.ownerInvitations.accept(principal, dto.password);
    return { ok: true };
  }

  @Post(':id/owner-invitation/resend')
  async resendOwnerInvitation(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string) {
    await this.ownerInvitations.resend(principal, id);
    return { ok: true };
  }

  /** Edit a branch's details. */
  @Patch(':id')
  async update(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBranchDto,
  ): Promise<{ branch: BranchRow }> {
    const branch = await this.branches.update(principal, id, dto);
    return { branch };
  }

  /** Soft-delete: retire a branch by flipping it inactive (AGENTS.md §3.2). */
  @Delete(':id')
  @HttpCode(200)
  async remove(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ branch: BranchRow }> {
    const branch = await this.branches.deactivate(principal, id);
    return { branch };
  }
}
