import 'server-only';
import { requireSession } from './auth';
import { resolveDbConfig } from './db-config';

/**
 * Single entry point for PostgREST access. Verifies the session on every call and
 * never logs headers or keys.
 */
export async function dbFetch(path: string, init: RequestInit = {}): Promise<Response> {
  await requireSession();
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

/** Runs a request and parses JSON; throws a generic Spanish error on non-2xx. */
export async function dbJson<T>(
  path: string,
  init: RequestInit = {},
  failure = 'No se pudo comunicar con la base de datos.',
): Promise<T> {
  const res = await dbFetch(path, init);
  if (!res.ok) {
    console.error('Supabase request failed', res.status, (await res.text()).slice(0, 300));
    throw new Error(failure);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : []) as T;
}
