/**
 * Supabase's current sb_* API keys are not JWTs, so they must be sent only in
 * `apikey`. Legacy anon/service_role keys remain JWTs and still use Bearer.
 */
export function supabaseApiKeyHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { apikey: apiKey };
  if (!apiKey.startsWith('sb_publishable_') && !apiKey.startsWith('sb_secret_')) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}
