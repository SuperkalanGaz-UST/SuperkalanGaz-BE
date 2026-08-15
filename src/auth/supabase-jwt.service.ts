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
    // The JWKS is fetched lazily on the first verify and then cached. Give that
    // cold fetch generous headroom (default is 5s): all authentication depends
    // on it, so a slow first fetch must not spuriously 401 every caller until
    // the cache warms.
    this.jwks = createRemoteJWKSet(new URL(`${this.issuer}/.well-known/jwks.json`), {
      timeoutDuration: 10000,
    });

    const secret = config.get<string>('SUPABASE_JWT_SECRET');
    this.hsSecret = secret ? new TextEncoder().encode(secret) : undefined;
  }

  /** Returns the token payload if valid; throws 401 otherwise. */
  async verify(token: string): Promise<JWTPayload> {
    const options = { issuer: this.issuer, audience: 'authenticated' };

    try {
      const { payload } = await jwtVerify(token, this.jwks, options);
      return payload;
    } catch {
      // Supabase projects often sign tokens with ES256 and publish the public keys
      // via JWKS. Only fall back to the legacy HS256 secret when a JWKS-based
      // verification fails and a shared secret is explicitly configured.
      if (!this.hsSecret) {
        throw new UnauthorizedException('Invalid or expired access token');
      }
      try {
        const { payload } = await jwtVerify(token, this.hsSecret, options);
        return payload;
      } catch {
        throw new UnauthorizedException('Invalid or expired access token');
      }
    }
  }
}
