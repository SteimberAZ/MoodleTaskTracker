import { isUuid, scopedQuery, userRowQuery } from './queries';
import type { ScheduleClass } from './sga-schedule';
import { GUAYAQUIL_OFFSET_MINUTES } from './time';

/** Pure helpers for the class schedule: display, notification preview, validation and PostgREST builders. */

export const WEEKDAY_NAMES = ['', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'] as const;

export const CLASS_LEAD_OPTIONS: { value: number | null; token: string; label: string }[] = [
  { value: null, token: 'off', label: 'Desactivado' },
  { value: 30, token: '30', label: '30 min' },
  { value: 60, token: '60', label: '1 hora' },
  { value: 180, token: '180', label: '3 horas' },
];

/** Most entries a schedule may hold (a week has far fewer; this only bounds abuse). */
export const MAX_SCHEDULE_ENTRIES = 60;
const MAX_TEXT = 200;

// ------------------------------------------------------------------------------ notification formatting
// Mirrors `class_reminders.py` (title_case, lead_label, class_message) so the preview matches what the worker sends.

const SMALL_WORDS = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'e', 'en', 'a']);
const ROMAN_NUMERALS = new Set(['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X']);
const ACRONYM = /^\([A-ZÁÉÍÓÚÑ]{2,5}\)[.,;:]?$/;
const PUNCT = new Set('()[].,;:"\''.split(''));

function stripPunct(word: string): string {
  let start = 0;
  let end = word.length;
  while (start < end && PUNCT.has(word[start])) start++;
  while (end > start && PUNCT.has(word[end - 1])) end--;
  return word.slice(start, end);
}

function capWord(word: string): string {
  const lower = word.toLowerCase();
  const chars = [...lower];
  const i = chars.findIndex((ch) => /\p{L}/u.test(ch));
  if (i < 0) return lower;
  chars[i] = chars[i].toUpperCase();
  return chars.join('');
}

/**
 * Title-cases SGA's upper-case text the Spanish way: small words (de, del, la, las, los, y, e, en, a) stay
 * lowercase except as the first word; roman numerals and parenthesised acronyms such as "(EMI)" stay upper-case.
 */
export function titleCase(text: string | null | undefined): string {
  return String(text ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((word, i) => {
      const core = stripPunct(word);
      if (ACRONYM.test(word)) return word;
      if (ROMAN_NUMERALS.has(core.toUpperCase())) return word.toUpperCase();
      if (i > 0 && SMALL_WORDS.has(core.toLowerCase())) return word.toLowerCase();
      return word.split('-').map(capWord).join('-');
    })
    .join(' ');
}

/** `30` -> `30 min`, `60` -> `1 hora`, `180` -> `3 horas`. */
export function leadLabel(minutes: number): string {
  if (minutes >= 60 && minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? '1 hora' : `${hours} horas`;
  }
  return `${minutes} min`;
}

const cleanText = (value: string | null | undefined): string => {
  const text = (value ?? '').trim();
  return text === '—' || text === '-' || text === '–' ? '' : text;
};

/** Title and body of the reminder the worker sends for one class (missing optional parts are left out). */
export function classNotification(cls: ScheduleClass, leadMinutes: number): { title: string; body: string } {
  let title = `📚 Clase en ${leadLabel(leadMinutes)}: ${titleCase(cls.subject) || 'Clase'}`;
  const parallel = cleanText(cls.parallel).replace(/^["']+|["']+$/g, '');
  if (parallel) title += ` (${parallel})`;

  const lines: string[] = [];
  if (cls.startTime && cls.endTime) lines.push(`🕘 ${cls.startTime}–${cls.endTime}`);
  else if (cls.startTime) lines.push(`🕘 ${cls.startTime}`);

  const room = [titleCase(cleanText(cls.roomType)), cleanText(cls.roomCode)].filter(Boolean).join(' ');
  const floor = cleanText(cls.floor);
  let where = [room, floor ? `piso ${floor}` : ''].filter(Boolean).join(', ');
  if (!where) where = titleCase(cleanText(cls.place));
  if (where) lines.push(`📍 ${where}`);

  const teacher = titleCase(cleanText(cls.teacher));
  if (teacher) lines.push(`👨‍🏫 ${teacher}`);
  return { title, body: lines.join('\n') };
}

// ------------------------------------------------------------------------------ lead time

/** The select value of the segmented control: "off", "30", "60" or "180"; anything else is rejected. */
export function parseClassLead(raw: unknown): { ok: true; minutes: number | null } | { ok: false } {
  if (typeof raw !== 'string') return { ok: false };
  const option = CLASS_LEAD_OPTIONS.find((o) => o.token === raw);
  return option ? { ok: true, minutes: option.value } : { ok: false };
}

/** Reads `class_reminder_minutes` from a `moodle_users` select; unknown values mean "off". */
export function resolveClassLead(rows: { class_reminder_minutes?: number | null }[] | null | undefined): number | null {
  const value = rows?.[0]?.class_reminder_minutes;
  return CLASS_LEAD_OPTIONS.some((o) => o.value !== null && o.value === value) ? (value as number) : null;
}

// ------------------------------------------------------------------------------ grouping and "now"

/** ISO weekday (1 = lunes ... 7 = domingo) in Ecuador time. */
export function guayaquilWeekday(now: Date): number {
  const day = new Date(now.getTime() + GUAYAQUIL_OFFSET_MINUTES * 60_000).getUTCDay();
  return day === 0 ? 7 : day;
}

export interface DayGroup<T> {
  weekday: number;
  name: string;
  items: T[];
}

/** Groups by weekday (Lunes to Domingo, empty days left out) and sorts each day by start time. */
export function groupByWeekday<T extends { weekday: number; startTime: string }>(items: T[]): DayGroup<T>[] {
  const groups: DayGroup<T>[] = [];
  for (let weekday = 1; weekday <= 7; weekday++) {
    const day = items.filter((i) => i.weekday === weekday).sort((a, b) => a.startTime.localeCompare(b.startTime));
    if (day.length) groups.push({ weekday, name: WEEKDAY_NAMES[weekday], items: day });
  }
  return groups;
}

/** The class that starts next (wrapping around the week), used as the sample in the notification preview. */
export function pickSampleClass(classes: ScheduleClass[], now: Date): ScheduleClass | null {
  if (classes.length === 0) return null;
  const local = new Date(now.getTime() + GUAYAQUIL_OFFSET_MINUTES * 60_000);
  const week = 7 * 24 * 60;
  const nowMinutes = ((guayaquilWeekday(now) - 1) * 24 + local.getUTCHours()) * 60 + local.getUTCMinutes();
  let best: ScheduleClass | null = null;
  let bestDelta = Infinity;
  for (const cls of classes) {
    const [h, m] = cls.startTime.split(':').map(Number);
    const delta = (((cls.weekday - 1) * 24 + h) * 60 + m - nowMinutes + week) % week;
    if (delta < bestDelta) {
      best = cls;
      bestDelta = delta;
    }
  }
  return best;
}

/** Stand-in used for the preview when the user has no schedule yet (obviously made up). */
export const SAMPLE_CLASS: ScheduleClass = {
  subject: 'PROGRAMACIÓN ORIENTADA A OBJETOS',
  level: 3,
  parallel: 'A',
  credits: 4,
  teacher: 'NOMBRE APELLIDO',
  department: null,
  weekday: 1,
  startTime: '07:00',
  endTime: '09:00',
  place: null,
  roomCode: '1-59-1-03-LC',
  roomType: 'LABORATORIO DE COMPUTACION',
  floor: '1',
};

// ------------------------------------------------------------------------------ validation

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function text(value: unknown, max = MAX_TEXT): string | null {
  if (typeof value !== 'string') return null;
  const clean = value.replace(/\s+/g, ' ').trim().slice(0, max);
  return clean || null;
}

function smallInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 99 ? value : null;
}

/** Validates untrusted class entries (the signed preview is checked again on save). Invalid entries are dropped. */
export function sanitizeClasses(input: unknown): ScheduleClass[] {
  if (!Array.isArray(input)) return [];
  const out: ScheduleClass[] = [];
  for (const raw of input.slice(0, MAX_SCHEDULE_ENTRIES)) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const subject = text(r.subject);
    const weekday = r.weekday;
    const start = typeof r.startTime === 'string' ? r.startTime : '';
    const end = typeof r.endTime === 'string' ? r.endTime : '';
    if (!subject || typeof weekday !== 'number' || !Number.isInteger(weekday) || weekday < 1 || weekday > 7) continue;
    if (!TIME.test(start) || !TIME.test(end) || start >= end) continue;
    out.push({
      subject,
      level: smallInt(r.level),
      parallel: text(r.parallel, 20),
      credits: smallInt(r.credits),
      teacher: text(r.teacher),
      department: text(r.department),
      weekday,
      startTime: start,
      endTime: end,
      place: text(r.place),
      roomCode: text(r.roomCode, 60),
      roomType: text(r.roomType, 120),
      floor: text(r.floor, 20),
    });
  }
  return out;
}

/** A period end date must be a real calendar day; anything else is dropped. */
export function sanitizePeriodEnd(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = DATE.exec(value);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d ? value : null;
}

export const sanitizePeriodLabel = (value: unknown): string | null => text(value, 120);

// ------------------------------------------------------------------------------ PostgREST builders

export interface ClassScheduleRow {
  id: string;
  user_id: string;
  subject: string;
  level: number | null;
  parallel: string | null;
  credits: number | null;
  teacher: string | null;
  department: string | null;
  weekday: number;
  start_time: string;
  end_time: string;
  place: string | null;
  room_code: string | null;
  room_type: string | null;
  floor: string | null;
  period_label: string | null;
  period_end: string | null;
  created_at: string;
}

export type ClassScheduleInsert = Omit<ClassScheduleRow, 'id' | 'created_at'>;

export interface SchedulePeriod {
  label: string | null;
  end: string | null;
}

/** DB row -> display model (PostgREST returns times as "07:00:00"). */
export function rowToClass(row: ClassScheduleRow): ScheduleClass {
  return {
    subject: row.subject,
    level: row.level,
    parallel: row.parallel,
    credits: row.credits,
    teacher: row.teacher,
    department: row.department,
    weekday: row.weekday,
    startTime: String(row.start_time).slice(0, 5),
    endTime: String(row.end_time).slice(0, 5),
    place: row.place,
    roomCode: row.room_code,
    roomType: row.room_type,
    floor: row.floor,
  };
}

/** `?user_id=eq.<me>&select=*&order=...`: the session user's classes only. */
export function scheduleListQuery(userId: string): string {
  return scopedQuery(userId, 'select=*', 'order=weekday.asc,start_time.asc');
}

/** Bulk insert body: every row has exactly the same keys (PostgREST requires it) and `user_id` is the session user's. */
export function scheduleInsertRows(userId: string, classes: ScheduleClass[], period: SchedulePeriod): ClassScheduleInsert[] {
  if (!isUuid(userId)) throw new Error('Invalid user id');
  return classes.map((c) => ({
    user_id: userId,
    subject: c.subject,
    level: c.level,
    parallel: c.parallel,
    credits: c.credits,
    teacher: c.teacher,
    department: c.department,
    weekday: c.weekday,
    start_time: c.startTime,
    end_time: c.endTime,
    place: c.place,
    room_code: c.roomCode,
    room_type: c.roomType,
    floor: c.floor,
    period_label: period.label,
    period_end: period.end,
  }));
}

/** `DELETE` of every class the user owns. */
export function scheduleDeleteAllQuery(userId: string): string {
  return scopedQuery(userId);
}

/**
 * `DELETE` of the user's classes except the freshly inserted ones. Replacing is insert-then-delete so a failed
 * insert never leaves the user without a schedule. Always scoped by `user_id`.
 */
export function scheduleDeleteExceptQuery(userId: string, keepIds: string[]): string {
  const ids = keepIds.filter(isUuid);
  if (ids.length !== keepIds.length) throw new Error('Invalid row id');
  return ids.length ? scopedQuery(userId, `id=not.in.(${ids.join(',')})`) : scopedQuery(userId);
}

/** Read of the lead time for the session user. */
export function classReminderQuery(userId: string): string {
  return userRowQuery(userId, 'select=class_reminder_minutes', 'limit=1');
}

/** `PATCH moodle_users?id=eq.<me>`: the row is always the session user's. Only null, 30, 60 and 180 are accepted. */
export function classReminderRequest(
  userId: string,
  minutes: number | null,
  nowIso: string,
): { query: string; body: { class_reminder_minutes: number | null; updated_at: string } } {
  if (minutes !== null && !CLASS_LEAD_OPTIONS.some((o) => o.value === minutes)) throw new Error('Invalid lead time');
  return { query: userRowQuery(userId, 'select=id'), body: { class_reminder_minutes: minutes, updated_at: nowIso } };
}
