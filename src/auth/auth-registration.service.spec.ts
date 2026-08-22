import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthRegistrationService } from './auth-registration.service';
import { RegisterDto } from './dto/register.dto';

const configValues: Record<string, string> = {
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_ANON_KEY: 'anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
};

function response(body: Record<string, unknown>, ok = true): Response {
  return {
    ok,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe('AuthRegistrationService', () => {
  let service: AuthRegistrationService;
  let fetchMock: jest.SpiedFunction<typeof fetch>;

  beforeEach(() => {
    const config = {
      get: jest.fn((key: string) => configValues[key]),
      getOrThrow: jest.fn((key: string) => configValues[key]),
    } as unknown as ConfigService;
    service = new AuthRegistrationService(config);
    fetchMock = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  const registration = (overrides: Partial<RegisterDto> = {}): RegisterDto => ({
    method: 'email',
    identifier: ' Customer@Example.com ',
    password: 'secret12',
    firstName: ' Ana ',
    lastName: ' Santos ',
    address: ' Las Pinas ',
    accountType: 'household',
    ...overrides,
  });

  it('uses the signup flow so an email OTP is sent, then assigns customer claims', async () => {
    fetchMock
      .mockResolvedValueOnce(
        response({
          id: 'customer-id',
          email: 'customer@example.com',
          identities: [{ id: 'identity-id' }],
        }),
      )
      .mockResolvedValueOnce(response({ id: 'customer-id' }));

    await expect(service.register(registration())).resolves.toEqual({
      needsConfirmation: true,
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://project.supabase.co/auth/v1/signup',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ apikey: 'anon-key' }),
        body: JSON.stringify({
          email: 'customer@example.com',
          password: 'secret12',
          data: {
            first_name: 'Ana',
            last_name: 'Santos',
            address: 'Las Pinas',
            account_type: 'household',
          },
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://project.supabase.co/auth/v1/admin/users/customer-id',
      expect.objectContaining({
        method: 'PUT',
        headers: expect.objectContaining({ apikey: 'service-key' }),
        body: JSON.stringify({
          app_metadata: {
            role: 'customer',
            branches: [],
            status: 'Active',
            account_type: 'household',
          },
        }),
      }),
    );
  });

  it('requests SMS signup for commercial customers', async () => {
    fetchMock
      .mockResolvedValueOnce(
        response({
          user: {
            id: 'commercial-id',
            identities: [{ id: 'phone-identity' }],
          },
        }),
      )
      .mockResolvedValueOnce(response({ id: 'commercial-id' }));

    await service.register(
      registration({
        method: 'phone',
        identifier: '+639171234567',
        accountType: 'commercial',
      }),
    );

    const firstRequest = fetchMock.mock.calls[0]?.[1];
    expect(firstRequest?.body).toBe(
      JSON.stringify({
        phone: '+639171234567',
        channel: 'sms',
        password: 'secret12',
        data: {
          first_name: 'Ana',
          last_name: 'Santos',
          address: 'Las Pinas',
          account_type: 'commercial',
        },
      }),
    );
  });

  it('reports an existing account without assigning claims to an obfuscated user', async () => {
    fetchMock.mockResolvedValueOnce(
      response({ id: 'obfuscated-id', identities: [] }),
    );

    await expect(service.register(registration())).rejects.toThrow(
      'has already been registered. Please sign in instead.',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('recognizes an immediately confirmed signup', async () => {
    fetchMock
      .mockResolvedValueOnce(
        response({
          access_token: 'access-token',
          user: { id: 'customer-id', identities: [{ id: 'identity-id' }] },
        }),
      )
      .mockResolvedValueOnce(response({ id: 'customer-id' }));

    await expect(service.register(registration())).resolves.toEqual({
      needsConfirmation: false,
    });
  });

  it('continues to OTP when claim assignment can be retried during bootstrap', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    fetchMock
      .mockResolvedValueOnce(
        response({ id: 'customer-id', identities: [{ id: 'identity-id' }] }),
      )
      .mockResolvedValueOnce(response({ message: 'Admin API unavailable' }, false));

    await expect(service.register(registration())).resolves.toEqual({
      needsConfirmation: true,
    });
    expect(warn).toHaveBeenCalledWith(
      '[auth] customer claims will be assigned during bootstrap',
      { id: 'customer-id', method: 'email' },
    );
    warn.mockRestore();
  });

  it.each([
    ['email', 'USER@example.com', { type: 'signup', email: 'user@example.com' }],
    ['phone', '+639171234567', { type: 'sms', phone: '+639171234567' }],
  ] as const)('resends a signup code by %s', async (method, identifier, body) => {
    fetchMock.mockResolvedValueOnce(response({}));

    await service.resendSignUpCode({ method, identifier });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://project.supabase.co/auth/v1/resend',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(body),
      }),
    );
  });

  it('surfaces the Auth provider error when resend is rate-limited', async () => {
    fetchMock.mockResolvedValueOnce(
      response({ message: 'For security purposes, you can only request this after 60 seconds.' }, false),
    );

    await expect(
      service.resendSignUpCode({ method: 'email', identifier: 'user@example.com' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
