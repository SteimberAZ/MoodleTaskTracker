import 'server-only';
import { requireSessionUserId } from './session';
import { resolveDbConfig } from './db-config';

function request(path: string, init: RequestInit): Promise<Response> {
  const { baseUrl, apikey, bearer } = resolveDbConfig(process.env);
  return fetch(`${baseUrl}/rest/v1/${path}`, {
    ...init,
    cache: 'no-store',
    headers: {
      apikey,
      Authorization: `Bearer ${bearer}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });
}

/**
 * Entry point for PostgREST access. Verifies the signed session cookie on every call and
 * never logs headers or keys. Callers must still scope per-user tables by the session user id.
 */
export async function dbFetch(path: string, init: RequestInit = {}): Promise<Response> {
  await requireSessionUserId();
  return request(path, init);
}

/**
 * Database access without a session. Reserved for the login flow (`lib/login-store.ts`),
 * which runs before a session exists. Do not use anywhere else.
 */
export function dbFetchAnonymous(path: string, init: RequestInit = {}): Promise<Response> {
  return request(path, init);
}

/** Runs a request and parses JSON; throws a generic Spanish error on non-2xx. */
export async function dbJson<T>(
  path: string,
  init: RequestInit = {},
  failure = 'No se pudo comunicar con la base de datos.',
): Promise<T> {
  const res = await dbFetch(path, init);
  if (!res.ok) {
    // Status only: error bodies can echo row data (topics, tokens).
    console.error('Supabase request failed', res.status);
    throw new Error(failure);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : []) as T;
}
