/** Pure resolution of the Supabase credentials from the environment (testable, no side effects). */
export interface DbConfig {
  baseUrl: string;
  apikey: string;
  bearer: string;
}

type Env = Record<string, string | undefined>;

/**
 * Preferred: SUPABASE_ANON_KEY as `apikey` + MOODLE_DB_JWT (role moodle_app) as bearer.
 * Fallback (legacy): SUPABASE_SERVICE_ROLE_KEY for both headers.
 */
export function resolveDbConfig(env: Env): DbConfig {
  const url = env.SUPABASE_URL;
  if (!url) throw new Error('Missing required environment variable SUPABASE_URL');
  const baseUrl = url.replace(/\/+$/, '');

  const jwt = env.MOODLE_DB_JWT;
  if (jwt) {
    const anon = env.SUPABASE_ANON_KEY;
    if (!anon) throw new Error('Missing required environment variable SUPABASE_ANON_KEY');
    return { baseUrl, apikey: anon, bearer: jwt };
  }

  const service = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!service) {
    throw new Error('Missing database credentials: set MOODLE_DB_JWT (+ SUPABASE_ANON_KEY) or SUPABASE_SERVICE_ROLE_KEY');
  }
  return { baseUrl, apikey: service, bearer: service };
}
