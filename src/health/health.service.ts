import { ServiceUnavailableException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

@Injectable()
export class HealthService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  async ready(): Promise<{ status: 'ready' }> {
    try {
      await this.dataSource.query('SELECT 1');
      return { status: 'ready' };
    } catch {
      // Do not leak database hostnames, error text, or connection details from
      // a public probe endpoint.
      throw new ServiceUnavailableException('API dependencies are unavailable');
    }
  }
}
