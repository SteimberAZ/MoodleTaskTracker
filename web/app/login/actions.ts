'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { startSession } from '@/lib/session';
import { resolveSessionSecret } from '@/lib/session-token';
import { MAX_PASSWORD, MAX_USERNAME, connectToMoodle, resolveMoodleUrl } from '@/lib/moodle';
import { decideLogin } from '@/lib/login-flow';
import { loginStore } from '@/lib/login-store';
import { safeNext } from '@/lib/safe-next';
import { dbFetchAnonymous } from '@/lib/db';
import { THROTTLED_MESSAGE, createLoginThrottle, isCredentialFailure, throttleKeys } from '@/lib/login-throttle';

/** Echoes only non-secret fields (never the password) so the form can be refilled after an error. */
export interface LoginState {
  error?: string;
  username?: string;
  inviteCode?: string;
}

const MAX_INVITE = 40;

// Runs before a session exists, hence the anonymous access (same as lib/login-store.ts).
const loginThrottle = createLoginThrottle((fn, args) =>
  dbFetchAnonymous(`rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) }),
);

/** The requester's address as the platform reports it (Vercel sets x-real-ip); '' when unknown. */
async function clientAddress(): Promise<string> {
  const h = await headers();
  return (h.get('x-real-ip') ?? h.get('x-forwarded-for')?.split(',')[0] ?? '').trim();
}

/**
 * Logs in with a UTM Moodle account. The password is read, used once against Moodle and
 * dropped: it is never stored, logged or returned in the form state.
 */
export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const username = String(formData.get('username') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const inviteCode = String(formData.get('inviteCode') ?? '').trim();
  const echo = { username, inviteCode };

  if (!(await resolveSessionSecret())) return { ...echo, error: 'El servidor no está configurado (SESSION_SECRET o MOODLE_DB_JWT).' };
  if (!username || !password) return { ...echo, error: 'Ingresa tu correo o usuario de la UTM y tu contraseña.' };
  if (username.length > MAX_USERNAME || password.length > MAX_PASSWORD || inviteCode.length > MAX_INVITE) {
    return { ...echo, error: 'Alguno de los datos es demasiado largo.' };
  }
  const moodleUrl = resolveMoodleUrl(process.env.MOODLE_URL);
  if (!moodleUrl) return { ...echo, error: 'MOODLE_URL no es válida: debe ser una URL https.' };

  // Reserve the attempt before the password reaches Moodle; fails open when the RPCs are unavailable.
  const keys = throttleKeys(username, await clientAddress());
  if (!(await loginThrottle.begin(keys)).allowed) return { ...echo, error: THROTTLED_MESSAGE };

  const moodle = await connectToMoodle(moodleUrl, username, password);
  await loginThrottle.finish(
    keys,
    moodle.ok ? 'success' : isCredentialFailure(moodle.message) ? 'failure' : 'released',
  );
  if (!moodle.ok) return { ...echo, error: moodle.message };

  let userId: string;
  try {
    const outcome = await decideLogin(loginStore, {
      moodleUrl,
      connection: moodle.value,
      username,
      inviteCode,
      adminUsername: process.env.ADMIN_MOODLE_USERNAME,
      adminTopic: process.env.ADMIN_NTFY_TOPIC,
    });
    if (!outcome.ok) return { ...echo, error: outcome.error };
    userId = outcome.userId;
  } catch {
    return { ...echo, error: 'No se pudo completar el inicio de sesión. Inténtalo de nuevo.' };
  }

  await startSession(userId);
  redirect(safeNext(formData.get('next')));
}
