import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { DecideStaffRegistrationDto } from './dto/decide-staff-registration.dto';
import { ListStaffRegistrationsQuery } from './dto/list-staff-registrations.query';
import { StaffRegistrationService } from './staff-registration.service';

@Controller('staff-registration')
@UseGuards(AuthGuard, RolesGuard)
@Roles('franchise-admin')
export class StaffRegistrationController {
  constructor(private readonly registrations: StaffRegistrationService) {}

  @Get('requests')
  async list(@Query() query: ListStaffRegistrationsQuery) {
    return { requests: await this.registrations.list(query) };
  }

  @Get('requests/:id/documents')
  async documents(@Param('id', ParseUUIDPipe) id: string) {
    return { documents: await this.registrations.documents(id) };
  }

  @Get('requests/:id/documents/:documentId/content')
  async documentContent(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
  ): Promise<never> {
    return this.registrations.documentContent(id, documentId);
  }

  @Patch('requests/:id/decision')
  async decide(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DecideStaffRegistrationDto,
  ): Promise<never> {
    return this.registrations.decide(id, dto);
  }
}
