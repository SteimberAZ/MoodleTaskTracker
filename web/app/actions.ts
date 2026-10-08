'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/auth';
import { endSession } from '@/lib/session';
import {
  createReminder,
  deleteReminder as removeReminder,
  getReminder,
  updateReminder,
  updateReminderIfActive,
} from '@/lib/reminders';
import { REMINDERS_PATH } from '@/lib/nav';
import { isSafeId } from '@/lib/queries';
import { getOwnedTask, setTaskMuted } from '@/lib/tasks';
import { computeNextFire } from '@/lib/schedule';
import { validateReminderForm, type FieldErrors, type ReminderFormInput } from '@/lib/validate';

/** Result of an inline action (mute, delete): the client keeps focus and shows `error` on failure. */
export interface ActionResult {
  ok: boolean;
  error?: string;
}

export interface FormState {
  error?: string;
  errors?: FieldErrors;
  values?: ReminderFormInput;
}

export async function logout(): Promise<void> {
  await endSession();
  redirect('/login');
}

/**
 * "Reconectar Moodle" on the disconnected banner: opens the login form for the same account, so the new
 * token is stored on the next sign-in. The session is kept until that sign-in succeeds (a failed or
 * throttled login must not log the user out), and the form is prefilled from the session on the server,
 * never from the URL (no username in browser history or request logs).
 */
export async function reconnectMoodle(): Promise<void> {
  await requireUser();
  redirect('/login?reconnect=1');
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

/**
 * Creates (id === null) or updates a reminder. Bound to the form with `.bind(null, id)`.
 * The owner always comes from the session, never from the form.
 */
export async function saveReminder(
  id: string | null,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();
  const values = readForm(formData);
  const result = validateReminderForm(values);
  if (!result.ok) return { errors: result.errors, values };
  const v = result.value;

  try {
    const existing = id === null ? null : await getReminder(user.id, id);
    if (id !== null && !existing) return { error: 'El recordatorio ya no existe.', values };

    // A linked task must belong to this user (keeping an unchanged link is always allowed).
    if (v.taskId && v.taskId !== existing?.task_id && !(await getOwnedTask(user.id, v.taskId))) {
      return { errors: { taskId: 'La tarea seleccionada no es válida.' }, values };
    }

    if (id === null) {
      await createReminder(user.id, {
        title: v.title,
        message: v.message,
        interval_minutes: v.intervalMinutes,
        starts_at: v.startsAt.toISOString(),
        ends_at: v.endsAt.toISOString(),
        next_fire_at: v.startsAt.toISOString(),
        active: true,
        task_id: v.taskId,
      });
    } else if (existing) {
      const next = computeNextFire({
        startsAt: v.startsAt,
        endsAt: v.endsAt,
        intervalMinutes: v.intervalMinutes,
        now: new Date(),
      });
      await updateReminder(user.id, id, {
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
  revalidatePath(REMINDERS_PATH);
  redirect(`${REMINDERS_PATH}?ok=saved`);
}

/**
 * Mutes (`muted = true`) or restores a task. Always scoped to the session user. It writes the target state
 * (not a toggle), so a repeated submit is harmless.
 */
export async function setTaskMute(taskId: string, muted: boolean): Promise<ActionResult> {
  const user = await requireUser();
  try {
    if (!(await setTaskMuted(user.id, taskId, muted))) return { ok: false, error: 'La tarea ya no existe.' };
  } catch {
    return { ok: false, error: 'No se pudo actualizar la tarea. Inténtalo de nuevo.' };
  }
  revalidatePath('/');
  if (isSafeId(taskId)) revalidatePath(`/tareas/${taskId}`);
  return { ok: true };
}

/**
 * Pauses (`active = false`) or resumes a reminder. A no-op when the row is already in that state, and the
 * write itself is conditional on the state that was read, so a double tap cannot undo it. `next_fire_at`
 * is only recomputed when resuming.
 */
export async function setReminderActive(id: string, active: boolean): Promise<void> {
  const user = await requireUser();
  try {
    const existing = await getReminder(user.id, id);
    // Nothing to write, but the card may be stale (the worker or another device changed it): the
    // revalidation below still runs so it re-renders from the stored state.
    if (!existing || existing.active === active) return;
    if (!active) {
      await updateReminderIfActive(user.id, id, true, { active: false });
    } else {
      const next = computeNextFire({
        startsAt: new Date(existing.starts_at),
        endsAt: new Date(existing.ends_at),
        intervalMinutes: existing.interval_minutes,
        now: new Date(),
      });
      await updateReminderIfActive(user.id, id, false, {
        active: next.active,
        next_fire_at: next.nextFireAt.toISOString(),
      });
    }
  } catch {
    // The card re-renders with the stored state, which is the honest feedback here.
  } finally {
    revalidatePath(REMINDERS_PATH);
  }
}

/** Deletes a reminder of the session user. Deleting one that is already gone counts as done. */
export async function deleteReminder(id: string): Promise<ActionResult> {
  const user = await requireUser();
  try {
    await removeReminder(user.id, id);
  } catch {
    return { ok: false, error: 'No se pudo eliminar el recordatorio. Inténtalo de nuevo.' };
  }
  revalidatePath(REMINDERS_PATH);
  return { ok: true };
}
