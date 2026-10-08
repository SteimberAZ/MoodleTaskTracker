'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/auth';
import { parseClassLead, sanitizeClasses, type SchedulePeriod } from '@/lib/class-schedule';
import {
  deleteClassSchedule,
  getClassReminderMinutes,
  getClassSchedule,
  replaceClassSchedule,
  setClassReminderMinutes,
} from '@/lib/class-schedule-store';
import { MAX_PDF_BYTES, extractPdfPages, hasPdfSignature } from '@/lib/pdf-text';
import { checkCooldown } from '@/lib/rate-limit';
import { parseScheduleEntries } from '@/lib/schedule-entries';
import { resolveImportSave } from '@/lib/schedule-save';
import { signSchedulePreview } from '@/lib/schedule-token';
import { resolveSessionSecret } from '@/lib/session-token';
import { parseSgaSchedule, type ScheduleClass } from '@/lib/sga-schedule';

export interface SchedulePreview {
  /** Signed copy of the parsed data; the import save step requires it, and takes the period from it. */
  token: string;
  periodLabel: string | null;
  periodEnd: string | null;
  classes: ScheduleClass[];
  warnings: string[];
}

export interface ImportState {
  error?: string;
  preview?: SchedulePreview;
}

const PARSE_COOLDOWN_MS = 4_000;
// Per server instance: enough to stop double clicks and accidental spam, not a security boundary.
const lastParse = new Map<string, number>();

/** Step 1: reads the uploaded PDF in memory (it is never stored) and returns the parsed classes for review. */
export async function previewSchedule(_prev: ImportState, formData: FormData): Promise<ImportState> {
  const user = await requireUser();
  const limit = checkCooldown(lastParse, user.id, Date.now(), PARSE_COOLDOWN_MS);
  if (!limit.allowed) return { error: `Espera ${limit.retryAfterSeconds} s antes de subir otro archivo.` };

  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) return { error: 'Selecciona el PDF de tu horario de clases.' };
  if (file.size > MAX_PDF_BYTES) return { error: 'El archivo supera los 2 MB. Descarga de nuevo el PDF desde el SGA.' };
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!hasPdfSignature(bytes)) return { error: 'El archivo no es un PDF válido.' };

  let parsed;
  try {
    parsed = parseSgaSchedule(await extractPdfPages(bytes));
  } catch {
    return { error: 'No se pudo leer el PDF. Verifica que sea el horario descargado del SGA y que no tenga contraseña.' };
  }
  if (parsed.classes.length === 0) {
    return { error: parsed.warnings[0] ?? 'No se encontraron clases en el PDF. ¿Es el «Horario de clases» del SGA?' };
  }

  const secret = await resolveSessionSecret();
  if (!secret) return { error: 'La aplicación no está configurada para firmar la vista previa.' };
  // Same validation the save step applies, so the indexes shown in the preview match the signed list.
  const classes = sanitizeClasses(parsed.classes);
  if (classes.length === 0) return { error: 'No se encontraron clases válidas en el PDF.' };
  const token = await signSchedulePreview(secret, user.id, {
    periodLabel: parsed.periodLabel,
    periodEnd: parsed.periodEnd,
    classes,
  });
  return { preview: { token, periodLabel: parsed.periodLabel, periodEnd: parsed.periodEnd, classes, warnings: parsed.warnings } };
}

export interface SaveState {
  error?: string;
  /** Number of classes saved. */
  saved?: number;
  /** Set when this first save also switched class reminders on with the default lead time (minutes). */
  defaultLead?: number;
}

/** Lead time switched on by the first schedule import, so a new user gets class reminders without a second step. */
// Not exported: a 'use server' module may only export async functions.
const DEFAULT_CLASS_LEAD_MINUTES = 30;

/**
 * Step 2 for an imported PDF: saves the (possibly edited) entries, replacing the previous schedule. The entries
 * are accepted only together with the signed upload token of this user, and are validated again from scratch.
 */
export async function saveImportedSchedule(input: { token: unknown; entries: unknown }): Promise<SaveState> {
  const user = await requireUser();
  const result = await resolveImportSave(await resolveSessionSecret(), user.id, input?.token, input?.entries);
  if (!result.ok) return { error: result.error };
  // Null means the read failed: then it is not known to be the first save, and the lead time is left alone.
  const before = await getClassSchedule(user.id);
  return persist(user.id, result.classes, result.period, before !== null && before.classes.length === 0);
}

/**
 * Saves manually edited entries of the session user's own schedule (no PDF involved). `user_id` always comes from
 * the session and the period label/end stay as already stored; entries are validated strictly.
 */
export async function saveEditedSchedule(input: { entries: unknown }): Promise<SaveState> {
  const user = await requireUser();
  const parsed = parseScheduleEntries(input?.entries);
  if (!parsed.ok) return { error: parsed.error };
  const current = await getClassSchedule(user.id);
  if (!current) return { error: 'No se pudo leer tu horario actual. Inténtalo de nuevo.' };
  return persist(user.id, parsed.classes, { label: current.periodLabel, end: current.periodEnd });
}

async function persist(userId: string, classes: ScheduleClass[], period: SchedulePeriod, firstSave = false): Promise<SaveState> {
  const ok = await replaceClassSchedule(userId, classes, period);
  if (!ok) return { error: 'No se pudo guardar el horario. Inténtalo de nuevo.' };
  const defaultLead = firstSave ? await applyDefaultLead(userId) : undefined;
  revalidatePath('/horario');
  return defaultLead ? { saved: classes.length, defaultLead } : { saved: classes.length };
}

/**
 * First schedule save: when class reminders are off (`class_reminder_minutes` null), switch them on with
 * DEFAULT_CLASS_LEAD_MINUTES. Returns the minutes set, or undefined when nothing changed or the update failed
 * (the schedule itself is saved either way).
 */
async function applyDefaultLead(userId: string): Promise<number | undefined> {
  try {
    const lead = await getClassReminderMinutes(userId);
    if (!lead.available || lead.minutes !== null) return undefined;
    return (await setClassReminderMinutes(userId, DEFAULT_CLASS_LEAD_MINUTES)) ? DEFAULT_CLASS_LEAD_MINUTES : undefined;
  } catch {
    return undefined;
  }
}

export interface DeleteState {
  error?: string;
}

/**
 * Removes the whole schedule of the session user (the confirmation happens in the browser). A failure comes back
 * as `{ error }` so the page can show it in place instead of the error screen.
 */
export async function deleteSchedule(): Promise<DeleteState> {
  const user = await requireUser();
  if (!(await deleteClassSchedule(user.id))) return { error: 'No se pudo borrar el horario. Inténtalo de nuevo.' };
  revalidatePath('/horario');
  return {};
}

export interface LeadState {
  /** The value that was saved (null = off); undefined until the first successful change. */
  minutes?: number | null;
  error?: string;
}

/** "Avisarme antes de cada clase": saves `moodle_users.class_reminder_minutes` for the session user only. */
export async function setClassReminder(_prev: LeadState, formData: FormData): Promise<LeadState> {
  const user = await requireUser();
  const lead = parseClassLead(formData.get('minutes'));
  if (!lead.ok) return { error: 'Valor no válido.' };
  try {
    if (!(await setClassReminderMinutes(user.id, lead.minutes))) return { error: 'No se pudo guardar el cambio.' };
  } catch {
    return { error: 'No se pudo guardar el cambio. Inténtalo de nuevo.' };
  }
  revalidatePath('/horario');
  return { minutes: lead.minutes };
}
