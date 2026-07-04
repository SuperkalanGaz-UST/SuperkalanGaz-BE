import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRemoteJWKSet, jwtVerify, JWTPayload } from 'jose';

/**
 * Verifies Supabase-issued access tokens locally (no round trip to the auth
 * server). Supports both signing setups Supabase projects can have:
 *  - asymmetric signing keys, published at /auth/v1/.well-known/jwks.json
 *  - the legacy shared HS256 secret (set SUPABASE_JWT_SECRET to use it)
 */
@Injectable()
export class SupabaseJwtService {
  private readonly issuer: string;
  private readonly hsSecret?: Uint8Array;
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(config: ConfigService) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL').replace(/\/$/, '');
    this.issuer = `${supabaseUrl}/auth/v1`;
    this.jwks = createRemoteJWKSet(new URL(`${this.issuer}/.well-known/jwks.json`));

    const secret = config.get<string>('SUPABASE_JWT_SECRET');
    this.hsSecret = secret ? new TextEncoder().encode(secret) : undefined;
  }

  /** Returns the token payload if valid; throws 401 otherwise. */
  async verify(token: string): Promise<JWTPayload> {
    const options = { issuer: this.issuer, audience: 'authenticated' };
    try {
      const { payload } = this.hsSecret
        ? await jwtVerify(token, this.hsSecret, options)
        : await jwtVerify(token, this.jwks, options);
      return payload;
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }
  }
}
