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
  type ClassScheduleInsert,
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

/** Atomic replace in one transaction (supabase_schema.sql). Older databases do not have it yet. */
const REPLACE_RPC = 'rpc/moodle_replace_class_schedule';

/** True when PostgREST says the function does not exist (HTTP 404 or error code PGRST202). */
async function isMissingFunction(res: Response): Promise<boolean> {
  if (res.status === 404) return true;
  try {
    const body = (await res.json()) as { code?: unknown } | null;
    return body?.code === 'PGRST202';
  } catch {
    return false;
  }
}

/**
 * Replace through the RPC: delete and insert run in one database transaction, in a single round trip.
 * Returns null when the function is missing (fall back), otherwise whether it succeeded.
 */
async function replaceViaRpc(userId: string, rows: ClassScheduleInsert[]): Promise<boolean | null> {
  const res = await dbFetch(REPLACE_RPC, {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ p_user_id: userId, p_rows: rows }),
  });
  if (res.ok) return true;
  if (await isMissingFunction(res)) return null;
  console.error('Replacing the class schedule failed', res.status);
  return false;
}

/** Fallback without the RPC: insert the new rows first, then delete the older ones. */
async function replaceInsertThenDelete(userId: string, rows: ClassScheduleInsert[]): Promise<boolean> {
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
}

/**
 * Replaces the user's schedule. Uses the `moodle_replace_class_schedule` RPC (atomic) when the database has it;
 * otherwise inserts the new rows first and then deletes the older ones, so a failed insert never leaves the user
 * without a schedule. Returns false when anything failed (a retry converges).
 */
export async function replaceClassSchedule(userId: string, classes: ScheduleClass[], period: SchedulePeriod): Promise<boolean> {
  try {
    const rows = scheduleInsertRows(userId, classes, period);
    const viaRpc = await replaceViaRpc(userId, rows);
    if (viaRpc !== null) return viaRpc;
    return await replaceInsertThenDelete(userId, rows);
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
