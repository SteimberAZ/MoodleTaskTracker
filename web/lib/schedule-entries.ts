import { MAX_SCHEDULE_ENTRIES, sanitizeClasses } from './class-schedule';
import type { ScheduleClass } from './sga-schedule';

/**
 * Strict validation of schedule entries, shared by the editor (browser) and the save actions (server) so both
 * apply the same rules. `sanitizeClasses` silently drops bad entries (used for parsed PDFs); this reports them.
 */

/** Max characters per text field (after collapsing whitespace). Mirrors `sanitizeClasses`. */
export const FIELD_LIMITS = {
  subject: 200,
  teacher: 200,
  place: 200,
  parallel: 20,
  roomType: 120,
  roomCode: 60,
  floor: 20,
} as const;

export type TextField = keyof typeof FIELD_LIMITS;
export type EntryField = TextField | 'weekday' | 'startTime' | 'endTime';
export type EntryErrors = Partial<Record<EntryField, string>>;

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const normalizeText = (value: string): string => value.replace(/\s+/g, ' ').trim();

const TEXT_FIELDS = Object.keys(FIELD_LIMITS) as TextField[];

/** Errors for one entry; empty object = valid. Accepts untrusted values (the server passes parsed JSON). */
export function validateEntryFields(raw: Record<string, unknown>): EntryErrors {
  const errors: EntryErrors = {};

  for (const field of TEXT_FIELDS) {
    const value = raw[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') {
      errors[field] = 'Texto no válido.';
      continue;
    }
    if (normalizeText(value).length > FIELD_LIMITS[field]) errors[field] = `Máximo ${FIELD_LIMITS[field]} caracteres.`;
  }
  const subject = raw.subject;
  if (typeof subject !== 'string' || !normalizeText(subject)) errors.subject = 'Escribe la materia.';

  const weekday = raw.weekday;
  if (typeof weekday !== 'number' || !Number.isInteger(weekday) || weekday < 1 || weekday > 7) errors.weekday = 'Elige un día.';

  const start = raw.startTime;
  const end = raw.endTime;
  const startOk = typeof start === 'string' && TIME.test(start);
  const endOk = typeof end === 'string' && TIME.test(end);
  if (!startOk) errors.startTime = 'Indica la hora de inicio.';
  if (!endOk) errors.endTime = 'Indica la hora de fin.';
  if (startOk && endOk && (start as string) >= (end as string)) errors.endTime = 'La hora de fin debe ser posterior al inicio.';
  return errors;
}

export type ParsedEntries = { ok: true; classes: ScheduleClass[] } | { ok: false; error: string };

/**
 * Server-side gate for entries sent by the browser: 1 to 60 objects, each fully valid (nothing is silently
 * dropped or truncated), normalised by `sanitizeClasses`. Extra keys such as `user_id` are ignored.
 */
export function parseScheduleEntries(input: unknown): ParsedEntries {
  if (!Array.isArray(input)) return { ok: false, error: 'Los datos del horario no son válidos.' };
  if (input.length === 0) return { ok: false, error: 'Agrega al menos una clase.' };
  if (input.length > MAX_SCHEDULE_ENTRIES) return { ok: false, error: `El horario admite hasta ${MAX_SCHEDULE_ENTRIES} clases.` };

  for (let i = 0; i < input.length; i++) {
    const raw: unknown = input[i];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: `Clase ${i + 1}: datos no válidos.` };
    const first = Object.values(validateEntryFields(raw as Record<string, unknown>))[0];
    if (first) return { ok: false, error: `Clase ${i + 1}: ${first}` };
  }
  const classes = sanitizeClasses(input);
  if (classes.length !== input.length) return { ok: false, error: 'Los datos del horario no son válidos.' };
  return { ok: true, classes };
}
