import { ConfigService } from '@nestjs/config';
import { GoTrueAdminService } from './gotrue-admin.service';

describe('GoTrueAdminService', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('sends an Auth invitation with a redirect and no protected role in user metadata', async () => {
    const fetchMock: jest.MockedFunction<typeof fetch> = jest.fn();
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          id: '44444444-4444-4444-8444-444444444444',
          email: 'ana.reyes@example.com',
          app_metadata: {},
          user_metadata: { display_name: 'Ana Reyes' },
          banned_until: null,
          created_at: '2026-08-25T01:00:00.000Z',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    global.fetch = fetchMock;
    const service = new GoTrueAdminService({
      getOrThrow: jest.fn((key: string) =>
        key === 'SUPABASE_URL'
          ? 'https://project.supabase.co'
          : 'service-role-secret',
      ),
    } as unknown as ConfigService);

    await service.inviteUser(
      'ana.reyes@example.com',
      'Ana Reyes',
      'https://crm.example.com/?invitation=franchise-admin',
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://project.supabase.co/auth/v1/invite?redirect_to=https%3A%2F%2Fcrm.example.com%2F%3Finvitation%3Dfranchise-admin',
    );
    expect(init).toBeDefined();
    if (!init) throw new Error('Expected fetch request options');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      email: 'ana.reyes@example.com',
      data: { display_name: 'Ana Reyes' },
    });
    expect(String(init.body)).not.toContain('franchise-admin');
  });
});
