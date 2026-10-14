import { supabaseApiKeyHeaders } from './supabase-api-key-headers';

describe('supabaseApiKeyHeaders', () => {
  it.each(['sb_publishable_project-key', 'sb_secret_project-key'])(
    'sends current key %s only as an API key',
    (apiKey) => {
      expect(supabaseApiKeyHeaders(apiKey)).toEqual({ apikey: apiKey });
    },
  );

  it.each(['legacy-anon-jwt', 'legacy-service-role-jwt'])(
    'keeps Bearer authentication for legacy JWT key %s',
    (apiKey) => {
      expect(supabaseApiKeyHeaders(apiKey)).toEqual({
        apikey: apiKey,
        Authorization: `Bearer ${apiKey}`,
      });
    },
  );
});
