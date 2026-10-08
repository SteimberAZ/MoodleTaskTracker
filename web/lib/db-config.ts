/** Pure resolution of the Supabase credentials from the environment (testable, no side effects). */
export interface DbConfig {
  baseUrl: string;
  apikey: string;
  bearer: string;
}

type Env = Record<string, string | undefined>;

/**
 * SUPABASE_ANON_KEY as `apikey` + MOODLE_DB_JWT (role moodle_app) as bearer. Fails closed: the web never falls
 * back to SUPABASE_SERVICE_ROLE_KEY, whose role bypasses the moodle_app grants and can read every user's token.
 */
export function resolveDbConfig(env: Env): DbConfig {
  const url = env.SUPABASE_URL;
  if (!url) throw new Error('Missing required environment variable SUPABASE_URL');
  const baseUrl = url.replace(/\/+$/, '');

  const jwt = env.MOODLE_DB_JWT?.trim();
  if (!jwt) {
    throw new Error(
      'Missing required environment variable MOODLE_DB_JWT (the moodle_app JWT; SUPABASE_SERVICE_ROLE_KEY is not accepted)',
    );
  }
  const anon = env.SUPABASE_ANON_KEY;
  if (!anon) throw new Error('Missing required environment variable SUPABASE_ANON_KEY');
  return { baseUrl, apikey: anon, bearer: jwt };
}
