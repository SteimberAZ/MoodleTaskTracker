import { describe, expect, it } from 'vitest';
import { resolveDbConfig } from '@/lib/db-config';

describe('resolveDbConfig', () => {
  it('uses the anon key as apikey and the moodle JWT as bearer', () => {
    expect(
      resolveDbConfig({ SUPABASE_URL: 'https://db.example.com/', SUPABASE_ANON_KEY: 'anon', MOODLE_DB_JWT: 'jwt' }),
    ).toEqual({ baseUrl: 'https://db.example.com', apikey: 'anon', bearer: 'jwt' });
  });

  it('never falls back to the service role key', () => {
    expect(() => resolveDbConfig({ SUPABASE_URL: 'https://db.example.com', SUPABASE_SERVICE_ROLE_KEY: 'svc' })).toThrow(
      /MOODLE_DB_JWT/,
    );
  });

  it('throws when nothing usable is configured', () => {
    expect(() => resolveDbConfig({})).toThrow();
    expect(() => resolveDbConfig({ SUPABASE_URL: 'https://x' })).toThrow();
    expect(() => resolveDbConfig({ SUPABASE_URL: 'https://x', MOODLE_DB_JWT: 'jwt' })).toThrow();
  });
});
