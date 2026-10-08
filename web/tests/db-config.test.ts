import { describe, expect, it } from 'vitest';
import { resolveDbConfig } from '@/lib/db-config';

describe('resolveDbConfig', () => {
  it('uses the anon key as apikey and the moodle JWT as bearer', () => {
    expect(
      resolveDbConfig({ SUPABASE_URL: 'https://db.example.com/', SUPABASE_ANON_KEY: 'anon', MOODLE_DB_JWT: 'jwt' }),
    ).toEqual({ baseUrl: 'https://db.example.com', apikey: 'anon', bearer: 'jwt' });
  });

  it('falls back to the service role key for both headers', () => {
    expect(resolveDbConfig({ SUPABASE_URL: 'https://db.example.com', SUPABASE_SERVICE_ROLE_KEY: 'svc' })).toEqual({
      baseUrl: 'https://db.example.com',
      apikey: 'svc',
      bearer: 'svc',
    });
  });

  it('throws when nothing usable is configured', () => {
    expect(() => resolveDbConfig({})).toThrow();
    expect(() => resolveDbConfig({ SUPABASE_URL: 'https://x' })).toThrow();
    expect(() => resolveDbConfig({ SUPABASE_URL: 'https://x', MOODLE_DB_JWT: 'jwt' })).toThrow();
  });
});
