import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS, resolveSessionSecret, signSession, verifySession } from './session-token';

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

/** User id from a validly signed, unexpired cookie (signature only; the user row is not loaded here). */
export async function getSessionUserId(): Promise<string | null> {
  const store = await cookies();
  return verifySession(await resolveSessionSecret(), store.get(SESSION_COOKIE)?.value);
}

/** Defense in depth: every data access re-checks the signed cookie. */
export async function requireSessionUserId(): Promise<string> {
  const userId = await getSessionUserId();
  if (!userId) redirect('/login');
  return userId;
}

export async function startSession(userId: string): Promise<void> {
  const secret = await resolveSessionSecret();
  if (!secret) throw new Error('Missing SESSION_SECRET or MOODLE_DB_JWT');
  const token = await signSession(secret, userId);
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

export async function endSession(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}
