'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/auth';
import { parseClassLead, sanitizeClasses } from '@/lib/class-schedule';
import { deleteClassSchedule, replaceClassSchedule, setClassReminderMinutes } from '@/lib/class-schedule-store';
import { MAX_PDF_BYTES, extractPdfPages, hasPdfSignature } from '@/lib/pdf-text';
import { checkCooldown } from '@/lib/rate-limit';
import { signSchedulePreview, verifySchedulePreview } from '@/lib/schedule-token';
import { resolveSessionSecret } from '@/lib/session-token';
import { parseSgaSchedule, type ScheduleClass } from '@/lib/sga-schedule';

export interface SchedulePreview {
  /** Signed copy of the parsed data; the save step trusts only this, never fields sent by the browser. */
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
}

/** Step 2: saves the previewed classes (minus the ones the user unchecked), replacing the previous schedule. */
export async function saveSchedule(_prev: SaveState, formData: FormData): Promise<SaveState> {
  const user = await requireUser();
  const data = await verifySchedulePreview(await resolveSessionSecret(), user.id, formData.get('token'));
  if (!data) return { error: 'La vista previa expiró. Sube el PDF otra vez.' };

  const keep = new Set(
    formData
      .getAll('keep')
      .filter((v): v is string => typeof v === 'string' && /^\d{1,3}$/.test(v))
      .map(Number),
  );
  const classes = data.classes.filter((_, index) => keep.has(index));
  if (classes.length === 0) return { error: 'Selecciona al menos una clase para guardar.' };

  const ok = await replaceClassSchedule(user.id, classes, { label: data.periodLabel, end: data.periodEnd });
  if (!ok) return { error: 'No se pudo guardar el horario. Inténtalo de nuevo.' };
  revalidatePath('/horario');
  return { saved: classes.length };
}

/** Removes the whole schedule of the session user (the confirmation happens in the browser). */
export async function deleteSchedule(): Promise<void> {
  const user = await requireUser();
  if (!(await deleteClassSchedule(user.id))) throw new Error('No se pudo borrar el horario.');
  revalidatePath('/horario');
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
