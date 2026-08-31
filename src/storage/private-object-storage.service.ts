import {
  BadGatewayException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface StoredObject {
  path: string;
}

export interface DownloadedObject {
  data: Buffer;
  contentType: string;
  contentLength: number;
}

/**
 * Provider adapter for the temporary private Supabase Storage decision.
 * This uses the server-side Storage REST API rather than the Supabase client
 * SDK, keeping all bucket access behind the NestJS authorization boundary.
 */
@Injectable()
export class PrivateObjectStorageService {
  private readonly supabaseUrl: string | null;
  private readonly serviceKey: string | null;
  private readonly bucket: string;

  constructor(config: ConfigService) {
    this.supabaseUrl = config.get<string>('SUPABASE_URL')?.replace(/\/$/, '') ?? null;
    this.serviceKey = config.get<string>('SUPABASE_SERVICE_ROLE_KEY') ?? null;
    this.bucket = config.get<string>('SUPABASE_STORAGE_BUCKET') ?? 'delivery-proofs';
  }

  async putObject(
    path: string,
    data: Buffer,
    contentType: string,
  ): Promise<StoredObject> {
    const response = await this.request('POST', path, {
      'Content-Type': contentType,
      'Content-Length': String(data.byteLength),
      'Cache-Control': 'private, max-age=0, no-store',
      'x-upsert': 'false',
    }, data);

    if (!response.ok) {
      await this.consumeError(response);
      throw new BadGatewayException('Proof storage rejected the upload');
    }

    return { path };
  }

  async getObject(path: string): Promise<DownloadedObject> {
    const response = await this.request('GET', path);
    if (!response.ok) {
      await this.consumeError(response);
      throw new BadGatewayException('Proof storage could not return the photo');
    }

    const data = Buffer.from(await response.arrayBuffer());
    return {
      data,
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
      contentLength: data.byteLength,
    };
  }

  /** Removes only an object that has not been committed to proof metadata. */
  async removeObject(path: string): Promise<void> {
    const response = await this.request('DELETE', path);
    if (!response.ok && response.status !== 404) {
      await this.consumeError(response);
      throw new BadGatewayException('Proof storage could not clean up the upload');
    }
  }

  private async request(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    extraHeaders: Record<string, string> = {},
    body?: Buffer,
  ): Promise<Response> {
    if (!this.supabaseUrl || !this.serviceKey) {
      throw new ServiceUnavailableException('Proof storage is not configured');
    }

    const encodedPath = path.split('/').map((part) => encodeURIComponent(part)).join('/');
    return fetch(
      `${this.supabaseUrl}/storage/v1/object/${encodeURIComponent(this.bucket)}/${encodedPath}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${this.serviceKey}`,
          apikey: this.serviceKey,
          ...extraHeaders,
        },
        // Node's fetch accepts Buffer bodies at runtime; the project targets
        // Node rather than the DOM, so keep the cast local to this adapter.
        body: body as unknown as ArrayBuffer | undefined,
      },
    );
  }

  private async consumeError(response: Response): Promise<void> {
    // Consume the body so the undici connection can be reused, without
    // returning provider details or credentials to the client.
    await response.arrayBuffer().catch(() => undefined);
  }
}
