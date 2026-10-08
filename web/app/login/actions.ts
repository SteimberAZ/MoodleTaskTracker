'use server';

import { redirect } from 'next/navigation';
import { startSession } from '@/lib/session';
import { MAX_PASSWORD, MAX_USERNAME, connectToMoodle, resolveMoodleUrl } from '@/lib/moodle';
import { decideLogin } from '@/lib/login-flow';
import { loginStore } from '@/lib/login-store';

/** Echoes only non-secret fields (never the password) so the form can be refilled after an error. */
export interface LoginState {
  error?: string;
  username?: string;
  inviteCode?: string;
}

const MAX_INVITE = 40;

/**
 * Logs in with a UTM Moodle account. The password is read, used once against Moodle and
 * dropped: it is never stored, logged or returned in the form state.
 */
export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const username = String(formData.get('username') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const inviteCode = String(formData.get('inviteCode') ?? '').trim();
  const echo = { username, inviteCode };

  if (!process.env.SESSION_SECRET) return { ...echo, error: 'El servidor no está configurado (SESSION_SECRET).' };
  if (!username || !password) return { ...echo, error: 'Ingresa tu correo o usuario de la UTM y tu contraseña.' };
  if (username.length > MAX_USERNAME || password.length > MAX_PASSWORD || inviteCode.length > MAX_INVITE) {
    return { ...echo, error: 'Alguno de los datos es demasiado largo.' };
  }
  const moodleUrl = resolveMoodleUrl(process.env.MOODLE_URL);
  if (!moodleUrl) return { ...echo, error: 'MOODLE_URL no es válida: debe ser una URL https.' };

  const moodle = await connectToMoodle(moodleUrl, username, password);
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
  redirect('/');
}
