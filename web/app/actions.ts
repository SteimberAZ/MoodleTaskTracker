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
} from '@/lib/reminders';
import { isSafeId } from '@/lib/queries';
import { getOwnedTask, setTaskMuted } from '@/lib/tasks';
import { computeNextFire } from '@/lib/schedule';
import { validateReminderForm, type FieldErrors, type ReminderFormInput } from '@/lib/validate';

export interface FormState {
  error?: string;
  errors?: FieldErrors;
  values?: ReminderFormInput;
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
  revalidatePath('/');
  redirect('/');
}

/** Mutes (`muted = true`) or restores a task. Always scoped to the session user; unknown ids are a no-op. */
export async function setTaskMute(taskId: string, muted: boolean): Promise<void> {
  const user = await requireUser();
  await setTaskMuted(user.id, taskId, muted);
  revalidatePath('/');
  if (isSafeId(taskId)) revalidatePath(`/tareas/${taskId}`);
}

export async function toggleReminder(id: string): Promise<void> {
  const user = await requireUser();
  const existing = await getReminder(user.id, id);
  if (!existing) return;
  if (existing.active) {
    await updateReminder(user.id, id, { active: false });
  } else {
    const next = computeNextFire({
      startsAt: new Date(existing.starts_at),
      endsAt: new Date(existing.ends_at),
      intervalMinutes: existing.interval_minutes,
      now: new Date(),
    });
    await updateReminder(user.id, id, { active: next.active, next_fire_at: next.nextFireAt.toISOString() });
  }
  revalidatePath('/');
}

export async function deleteReminder(id: string): Promise<void> {
  const user = await requireUser();
  await removeReminder(user.id, id);
  revalidatePath('/');
}
