import {
  Body,
  Controller,
  Get,
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
import { CreateGovernanceRequestDto } from './dto/create-governance-request.dto';
import { DecideGovernanceRequestDto } from './dto/decide-governance-request.dto';
import {
  ListGovernanceAuditQuery,
  ListGovernanceRequestsQuery,
} from './dto/list-governance.query';
import { GovernanceAuditService } from './governance-audit.service';
import { GovernanceService } from './governance.service';

@Controller('governance')
@UseGuards(AuthGuard, RolesGuard)
export class GovernanceController {
  constructor(
    private readonly governance: GovernanceService,
    private readonly audit: GovernanceAuditService,
  ) {}

  @Post('requests')
  @Roles('franchise-admin')
  async submit(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: CreateGovernanceRequestDto,
  ) {
    return { request: this.toRequestRow(await this.governance.submit(principal, dto)) };
  }

  @Get('requests')
  @Roles('super-admin', 'franchise-admin')
  async requests(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListGovernanceRequestsQuery,
  ) {
    return {
      requests: (await this.governance.list(principal, query)).map((request) =>
        this.toRequestRow(request),
      ),
    };
  }

  @Patch('requests/:id/decision')
  @Roles('super-admin')
  async decide(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DecideGovernanceRequestDto,
  ) {
    const result = await this.governance.decide(principal, id, dto);
    return {
      request: this.toRequestRow(result.request),
      ...(result.temporaryPassword
        ? { temporary_password: result.temporaryPassword }
        : {}),
    };
  }

  @Get('dashboard')
  @Roles('super-admin')
  async dashboard() {
    const dashboard = await this.governance.dashboard();
    return {
      ...dashboard,
      priorityRequests: dashboard.priorityRequests.map((request) =>
        this.toRequestRow(request),
      ),
    };
  }

  @Get('admin-accounts')
  @Roles('super-admin')
  async adminAccounts() {
    const result = await this.governance.adminAccounts();
    return {
      accounts: result.accounts,
      requests: result.requests.map((request) => this.toRequestRow(request)),
    };
  }

  @Get('audit')
  @Roles('super-admin')
  async auditEvents(@Query() query: ListGovernanceAuditQuery) {
    return { events: await this.audit.list(query.category, query.limit) };
  }

  @Get('security')
  @Roles('super-admin')
  async security() {
    return this.governance.securitySummary();
  }

  private toRequestRow(request: Awaited<ReturnType<GovernanceService['submit']>>) {
    return {
      id: request.id,
      type: request.type,
      status: request.status,
      title: request.title,
      reason: request.reason,
      risk_level: request.riskLevel,
      branch_id: request.branchId,
      requested_by: request.requestedBy,
      requested_by_name: request.requestedByName,
      payload: request.payload,
      submitted_at: request.submittedAt,
      decided_by: request.decidedBy,
      decided_by_name: request.decidedByName,
      decision_reason: request.decisionReason,
      decided_at: request.decidedAt,
      applied_at: request.appliedAt,
    };
  }
}
