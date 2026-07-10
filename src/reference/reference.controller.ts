import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { ListStoreLocationsQuery } from './dto/list-store-locations.query';
import { ReferenceService, StoreLocationRow } from './reference.service';

/**
 * Franchise-global reference data for the branch-registration flow. Read-only.
 *
 * TODO(branch-provisioning role — UNCONFIRMED): The screen that consumes this
 * endpoint is labelled "System Admin," but NONE of the four defined roles
 * (Franchise Administrator, Branch Owner, Branch Manager, Customer) is currently
 * assigned "branch provisioning" ownership (AGENTS.md §13 — do not assume open
 * decisions). So the role guard is deliberately STUBBED: for now the endpoint
 * requires only authentication (AuthGuard), and is intentionally NOT silently
 * granted to franchise-admin. Once the owning role is confirmed, add RolesGuard
 * + @Roles(...) here, e.g.:
 *
 *   @UseGuards(AuthGuard, RolesGuard)
 *   @Roles('<confirmed-branch-provisioning-role>')
 */
@Controller('reference')
@UseGuards(AuthGuard)
export class ReferenceController {
  constructor(private readonly reference: ReferenceService) {}

  @Get('store-locations')
  async storeLocations(
    @Query() query: ListStoreLocationsQuery,
  ): Promise<{ locations: StoreLocationRow[] }> {
    const locations = await this.reference.listStoreLocations(query);
    return { locations };
  }
}
