import 'server-only';
import { requireSessionUserId } from './session';
import { resolveDbConfig } from './db-config';
import { parseContentRange } from './pagination';

/** Upper bound for one PostgREST round trip, so a hung database never holds a page or action open. */
export const DB_TIMEOUT_MS = 8000;
export const DB_FAILURE = 'No se pudo comunicar con la base de datos.';

async function request(path: string, init: RequestInit): Promise<Response> {
  const { baseUrl, apikey, bearer } = resolveDbConfig(process.env);
  try {
    return await fetch(`${baseUrl}/rest/v1/${path}`, {
      ...init,
      cache: 'no-store',
      signal: init.signal ?? AbortSignal.timeout(DB_TIMEOUT_MS),
      headers: {
        apikey,
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/json',
        ...init.headers,
      },
    });
  } catch (error) {
    // Timeout (TimeoutError), abort (AbortError) or a network failure: log the error name only, since
    // messages can carry the URL, and surface the same friendly error as a non-2xx answer.
    console.error('Supabase request failed', error instanceof Error ? error.name : 'unknown');
    throw new Error(DB_FAILURE);
  }
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
 * Database access without a session. Reserved for the login flow (`lib/login-store.ts` and the login
 * throttle RPCs in `app/login/actions.ts`), which runs before a session exists. Do not use anywhere else.
 */
export function dbFetchAnonymous(path: string, init: RequestInit = {}): Promise<Response> {
  return request(path, init);
}

/**
 * Reads one page together with the exact total (`Prefer: count=exact` + `Content-Range`).
 * PostgREST answers 416 when the offset is past the end; that is reported as an empty page
 * with the real total so the caller can clamp the page and ask again.
 */
export async function dbJsonCounted<T>(
  path: string,
  failure = DB_FAILURE,
): Promise<{ rows: T[]; total: number }> {
  const res = await dbFetch(path, { headers: { Prefer: 'count=exact' } });
  const total = parseContentRange(res.headers.get('content-range'));
  if (res.status === 416) return { rows: [], total: total ?? 0 };
  if (!res.ok) {
    console.error('Supabase request failed', res.status);
    throw new Error(failure);
  }
  const text = await res.text();
  const rows = (text ? JSON.parse(text) : []) as T[];
  return { rows, total: total ?? rows.length };
}

/** Runs a request and parses JSON; throws a generic Spanish error on non-2xx. */
export async function dbJson<T>(
  path: string,
  init: RequestInit = {},
  failure = DB_FAILURE,
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
