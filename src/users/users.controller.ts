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
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { Principal } from '../auth/principal';
import { CurrentPrincipal, Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { CreateUserDto } from './dto/create-user.dto';
import { ChangeOwnPasswordDto } from './dto/change-own-password.dto';
import { ListUsersQuery } from './dto/list-users.query';
import { UpdateOwnProfileDto } from './dto/update-own-profile.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { CrmUser, OwnProfile, UsersService } from './users.service';

/**
 * Staff-account management. Response shapes intentionally match the legacy
 * Next.js /api/users handlers so the web dashboard needed no contract change.
 * BM has no access: managing accounts is FA/BO territory (AGENTS.md §7).
 */
@Controller('users')
@UseGuards(AuthGuard, RolesGuard)
@Roles('franchise-admin', 'branch-owner')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  /**
   * The caller's own profile. Every authenticated persona needs this at login
   * to know which dashboard to render and its branch scope — so unlike the
   * management endpoints it is open to all three roles (overriding the
   * class-level @Roles). Scope still comes from the verified Principal, never
   * the client.
   */
  @Get('me')
  @Roles('franchise-admin', 'branch-owner', 'branch-manager')
  async me(
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ user: ReturnType<UsersController['toRow']> }> {
    const profile = await this.users.findById(principal.userId);
    return { user: this.toRow(profile) };
  }

  /**
   * The authenticated administrator or owner may maintain only their own
   * personal fields; role, branch scope, and status never come from this payload.
   */
  @Patch('me')
  @Roles('franchise-admin', 'branch-owner')
  async updateMe(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: UpdateOwnProfileDto,
  ): Promise<{ user: ReturnType<UsersController['toOwnProfileRow']> }> {
    const profile = await this.users.updateOwnProfile(principal, dto);
    return { user: this.toOwnProfileRow(profile) };
  }

  @Patch('me/password')
  @Roles('franchise-admin', 'branch-owner')
  async changeMyPassword(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: ChangeOwnPasswordDto,
  ): Promise<{ ok: true }> {
    await this.users.changeOwnPassword(principal, dto.password);
    return { ok: true };
  }

  @Get()
  async list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListUsersQuery,
  ): Promise<{ users: ReturnType<UsersController['toRow']>[] }> {
    const profiles = await this.users.list(principal, query);
    return { users: profiles.map((p) => this.toRow(p)) };
  }

  @Post()
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: CreateUserDto,
  ): Promise<{ id: string }> {
    return this.users.create(principal, dto);
  }

  @Patch(':id')
  async update(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
  ): Promise<{ ok: true }> {
    await this.users.update(principal, id, dto);
    return { ok: true };
  }

  @Delete(':id')
  @HttpCode(200)
  async remove(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ ok: true }> {
    await this.users.softDelete(principal, id);
    return { ok: true };
  }

  private toRow(u: CrmUser) {
    return {
      id: u.id,
      email: u.email,
      username: u.username,
      display_name: u.displayName,
      role: u.role,
      branches: u.branches,
      phone: u.phone,
      status: u.status,
      created_at: u.createdAt,
    };
  }

  private toOwnProfileRow(u: OwnProfile) {
    return {
      id: u.id,
      email: u.email,
      username: u.username,
      display_name: u.displayName,
      role: u.role,
      branches: u.branches,
      phone: u.phone,
      status: u.status,
    };
  }
}
