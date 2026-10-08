import 'server-only';
import { dbFetch, dbJson } from './db';
import {
  classReminderQuery,
  classReminderRequest,
  resolveClassLead,
  rowToClass,
  scheduleDeleteAllQuery,
  scheduleDeleteExceptQuery,
  scheduleInsertRows,
  scheduleListQuery,
  type ClassScheduleRow,
  type SchedulePeriod,
} from './class-schedule';
import type { ScheduleClass } from './sga-schedule';

const TABLE = 'moodle_class_schedule';

export interface StoredSchedule {
  classes: ScheduleClass[];
  periodLabel: string | null;
  periodEnd: string | null;
}

/**
 * The user's imported schedule. Null when it cannot be read (e.g. the migration is not applied yet):
 * pages show a friendly "not available yet" instead of failing.
 */
export async function getClassSchedule(userId: string): Promise<StoredSchedule | null> {
  try {
    const rows = await dbJson<ClassScheduleRow[]>(`${TABLE}${scheduleListQuery(userId)}`);
    return {
      classes: rows.map(rowToClass),
      periodLabel: rows.find((r) => r.period_label)?.period_label ?? null,
      periodEnd: rows.find((r) => r.period_end)?.period_end ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Replaces the user's schedule: insert the new rows first, then delete the older ones, so a failed insert
 * never leaves the user without a schedule. Returns false when anything failed (a retry converges).
 */
export async function replaceClassSchedule(userId: string, classes: ScheduleClass[], period: SchedulePeriod): Promise<boolean> {
  try {
    const rows = scheduleInsertRows(userId, classes, period);
    const inserted = await dbJson<{ id: string }[]>(`${TABLE}?select=id`, {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(rows),
    });
    if (inserted.length !== rows.length) return false;
    const res = await dbFetch(`${TABLE}${scheduleDeleteExceptQuery(userId, inserted.map((r) => r.id))}`, {
      method: 'DELETE',
      headers: { Prefer: 'return=minimal' },
    });
    if (!res.ok) console.error('Deleting the previous class schedule failed', res.status);
    return res.ok;
  } catch {
    return false;
  }
}

export async function deleteClassSchedule(userId: string): Promise<boolean> {
  try {
    const res = await dbFetch(`${TABLE}${scheduleDeleteAllQuery(userId)}`, {
      method: 'DELETE',
      headers: { Prefer: 'return=minimal' },
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Lead time in minutes (null = off). `available` is false before the migration adds the column. */
export async function getClassReminderMinutes(userId: string): Promise<{ available: boolean; minutes: number | null }> {
  try {
    const rows = await dbJson<{ class_reminder_minutes: number | null }[]>(`moodle_users${classReminderQuery(userId)}`);
    return { available: true, minutes: resolveClassLead(rows) };
  } catch {
    return { available: false, minutes: null };
  }
}

/** Saves the lead time for the session user only. Returns false when nothing was updated. */
export async function setClassReminderMinutes(userId: string, minutes: number | null): Promise<boolean> {
  const { query, body } = classReminderRequest(userId, minutes, new Date().toISOString());
  const rows = await dbJson<{ id: string }[]>(
    `moodle_users${query}`,
    { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(body) },
    'No se pudo guardar el cambio.',
  );
  return rows.length > 0;
}
