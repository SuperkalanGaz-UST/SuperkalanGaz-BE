import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { Principal } from '../auth/principal';
import { CurrentPrincipal, Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { BranchesService, CreateBranchResult } from './branches.service';
import { CreateBranchDto } from './dto/create-branch.dto';

/**
 * Branch registry. Registering a branch is a franchise-wide administrative act,
 * so only Franchise Admins may POST here (AGENTS.md §7 — FA manages branch
 * accounts; BO/BM cannot). Scope comes from the verified Principal.
 */
@Controller('branches')
@UseGuards(AuthGuard, RolesGuard)
@Roles('franchise-admin')
export class BranchesController {
  constructor(private readonly branches: BranchesService) {}

  @Post()
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: CreateBranchDto,
  ): Promise<CreateBranchResult> {
    return this.branches.create(principal, dto);
  }
}
