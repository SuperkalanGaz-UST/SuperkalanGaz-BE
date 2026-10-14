import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
import { SupabaseJwtService } from './supabase-jwt.service';

jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(),
  decodeProtectedHeader: jest.fn(),
  jwtVerify: jest.fn(),
}));

describe('SupabaseJwtService', () => {
  const jwks = jest.fn();
  const payload = { sub: 'user-id', aud: 'authenticated' };

  const createService = (secret?: string) => {
    (createRemoteJWKSet as jest.Mock).mockReturnValue(jwks);
    const config = {
      getOrThrow: jest.fn(() => 'https://project.supabase.co'),
      get: jest.fn(() => secret),
    } as unknown as ConfigService;
    return new SupabaseJwtService(config);
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (jwtVerify as jest.Mock).mockResolvedValue({ payload });
  });

  it('uses JWKS for ES256 even when a legacy shared secret remains configured', async () => {
    (decodeProtectedHeader as jest.Mock).mockReturnValue({ alg: 'ES256' });
    const service = createService('legacy-secret');

    await expect(service.verify('token')).resolves.toEqual(payload);

    expect(jwtVerify).toHaveBeenCalledWith(
      'token',
      jwks,
      expect.objectContaining({ algorithms: ['ES256'] }),
    );
  });

  it('uses the configured shared secret only for legacy HS256 tokens', async () => {
    (decodeProtectedHeader as jest.Mock).mockReturnValue({ alg: 'HS256' });
    const service = createService('legacy-secret');

    await expect(service.verify('token')).resolves.toEqual(payload);

    expect(jwtVerify).toHaveBeenCalledWith(
      'token',
      expect.any(Uint8Array),
      expect.objectContaining({ algorithms: ['HS256'] }),
    );
  });

  it('rejects unsupported signing algorithms before verification', async () => {
    (decodeProtectedHeader as jest.Mock).mockReturnValue({ alg: 'none' });
    const service = createService('legacy-secret');

    await expect(service.verify('token')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(jwtVerify).not.toHaveBeenCalled();
  });
});
