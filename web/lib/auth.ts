import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS, signSession, verifySession } from './session-token';

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export async function hasValidSession(): Promise<boolean> {
  const store = await cookies();
  return verifySession(process.env.SESSION_SECRET, store.get(SESSION_COOKIE)?.value);
}

/** Defense in depth: every server action and data access re-checks the session. */
export async function requireSession(): Promise<void> {
  if (!(await hasValidSession())) redirect('/login');
}

export async function startSession(): Promise<void> {
  const token = await signSession(requireEnv('SESSION_SECRET'));
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
