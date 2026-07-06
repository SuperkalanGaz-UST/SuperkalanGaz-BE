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
import { Principal } from '../auth/principal';
import { CurrentPrincipal, Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { BranchRow, BranchesService, CreateBranchResult } from './branches.service';
import { CreateBranchDto } from './dto/create-branch.dto';
import { ReviewBranchDto } from './dto/review-branch.dto';

/**
 * Branch registry. Registering, listing, and reviewing branches are all
 * franchise-wide administrative acts, so only Franchise Admins may reach these
 * (AGENTS.md §7 — FA manages branch accounts; BO/BM cannot). Scope comes from
 * the verified Principal.
 */
@Controller('branches')
@UseGuards(AuthGuard, RolesGuard)
@Roles('franchise-admin')
export class BranchesController {
  constructor(private readonly branches: BranchesService) {}

  @Get()
  async list(): Promise<{ branches: BranchRow[] }> {
    const branches = await this.branches.list();
    return { branches };
  }

  @Post()
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: CreateBranchDto,
  ): Promise<CreateBranchResult> {
    return this.branches.create(principal, dto);
  }

  @Patch(':id/review')
  async review(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewBranchDto,
  ): Promise<{ branch: BranchRow }> {
    const branch = await this.branches.review(principal, id, dto);
    return { branch };
  }
}
