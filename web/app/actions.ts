'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { endSession, requireSession, startSession } from '@/lib/auth';
import { safeEqual } from '@/lib/session-token';
import {
  createReminder,
  deleteReminder as removeReminder,
  getReminder,
  updateReminder,
} from '@/lib/reminders';
import { computeNextFire } from '@/lib/schedule';
import { deleteCredentials, saveCredentials } from '@/lib/credentials';
import { MAX_PASSWORD, MAX_USERNAME, connectToMoodle, resolveMoodleUrl } from '@/lib/moodle';
import { validateReminderForm, type FieldErrors, type ReminderFormInput } from '@/lib/validate';

export interface LoginState {
  error?: string;
}

export interface FormState {
  error?: string;
  errors?: FieldErrors;
  values?: ReminderFormInput;
}

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const expected = process.env.APP_PASSWORD;
  if (!expected || !process.env.SESSION_SECRET) {
    return { error: 'El servidor no está configurado (APP_PASSWORD / SESSION_SECRET).' };
  }
  const given = String(formData.get('password') ?? '');
  if (!(await safeEqual(given, expected))) {
    // Small delay slows down online guessing without any shared state.
    await new Promise((resolve) => setTimeout(resolve, 600));
    return { error: 'Contraseña incorrecta.' };
  }
  await startSession();
  redirect('/');
}

export async function logout(): Promise<void> {
  await endSession();
  redirect('/login');
}

function readForm(formData: FormData): ReminderFormInput {
  const text = (name: string) => String(formData.get(name) ?? '');
  return {
    title: text('title'),
    message: text('message'),
    amount: text('amount'),
    unit: text('unit'),
    startsAt: text('startsAt'),
    endsAt: text('endsAt'),
    taskId: text('taskId'),
  };
}

/** Creates (id === null) or updates a reminder. Bound to the form with `.bind(null, id)`. */
export async function saveReminder(
  id: string | null,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  await requireSession();
  const values = readForm(formData);
  const result = validateReminderForm(values);
  if (!result.ok) return { errors: result.errors, values };
  const v = result.value;

  try {
    if (id === null) {
      await createReminder({
        title: v.title,
        message: v.message,
        interval_minutes: v.intervalMinutes,
        starts_at: v.startsAt.toISOString(),
        ends_at: v.endsAt.toISOString(),
        next_fire_at: v.startsAt.toISOString(),
        active: true,
        task_id: v.taskId,
      });
    } else {
      const existing = await getReminder(id);
      if (!existing) return { error: 'El recordatorio ya no existe.', values };
      const next = computeNextFire({
        startsAt: v.startsAt,
        endsAt: v.endsAt,
        intervalMinutes: v.intervalMinutes,
        now: new Date(),
      });
      await updateReminder(id, {
        title: v.title,
        message: v.message,
        interval_minutes: v.intervalMinutes,
        starts_at: v.startsAt.toISOString(),
        ends_at: v.endsAt.toISOString(),
        next_fire_at: next.nextFireAt.toISOString(),
        active: existing.active && next.active,
        task_id: v.taskId,
      });
    }
  } catch {
    return { error: 'No se pudo guardar. Inténtalo de nuevo.', values };
  }
  revalidatePath('/');
  redirect('/');
}

export async function toggleReminder(id: string): Promise<void> {
  await requireSession();
  const existing = await getReminder(id);
  if (!existing) return;
  if (existing.active) {
    await updateReminder(id, { active: false });
  } else {
    const next = computeNextFire({
      startsAt: new Date(existing.starts_at),
      endsAt: new Date(existing.ends_at),
      intervalMinutes: existing.interval_minutes,
      now: new Date(),
    });
    await updateReminder(id, { active: next.active, next_fire_at: next.nextFireAt.toISOString() });
  }
  revalidatePath('/');
}

export async function deleteReminder(id: string): Promise<void> {
  await requireSession();
  await removeReminder(id);
  revalidatePath('/');
}

export interface MoodleConnectState {
  error?: string;
  connected?: boolean;
}

/**
 * Exchanges the Moodle password for a mobile token on the server. The password is read,
 * used once and dropped: it is never stored, logged or returned in the form state.
 */
export async function connectMoodle(_prev: MoodleConnectState, formData: FormData): Promise<MoodleConnectState> {
  await requireSession();
  const username = String(formData.get('username') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  if (!username || !password) return { error: 'Ingresa tu usuario y contraseña de Moodle.' };
  if (username.length > MAX_USERNAME || password.length > MAX_PASSWORD) {
    return { error: 'Usuario o contraseña demasiado largos.' };
  }
  const moodleUrl = resolveMoodleUrl(process.env.MOODLE_URL);
  if (!moodleUrl) return { error: 'MOODLE_URL no es válida: debe ser una URL https.' };

  const result = await connectToMoodle(moodleUrl, username, password);
  if (!result.ok) return { error: result.message };

  try {
    await saveCredentials({
      moodle_url: moodleUrl,
      username,
      token: result.value.token,
      site_userid: result.value.siteUserId,
      fullname: result.value.fullname,
    });
  } catch {
    return { error: 'Moodle aceptó las credenciales, pero no se pudo guardar la conexión.' };
  }
  revalidatePath('/moodle');
  return { connected: true };
}

export async function disconnectMoodle(): Promise<void> {
  await requireSession();
  await deleteCredentials();
  revalidatePath('/moodle');
}
