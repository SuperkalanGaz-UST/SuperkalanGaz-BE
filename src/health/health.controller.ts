import { Controller, Get } from '@nestjs/common';
import { HealthService } from './health.service';

/** Public, low-information endpoints used by the platform's container probes. */
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get('live')
  live(): { status: 'ok' } {
    return this.health.live();
  }

  @Get('ready')
  ready(): Promise<{ status: 'ready' }> {
    return this.health.ready();
  }
}
