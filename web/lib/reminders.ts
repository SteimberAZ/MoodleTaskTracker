import 'server-only';
import { dbJson } from './db';
import { clampPage } from './pagination';
import { isUuid, ownedRowQuery, ownedTasksInQuery, scopedQuery } from './queries';
import {
  ownedEmbeddedTask,
  reminderActiveFilter,
  reminderPageQuery,
  reminderRowQuery,
  type EmbeddedTask,
} from './reminder-query';
import { dbRead, DbReadError } from './tasks';

export interface Reminder {
  id: string;
  title: string;
  message: string | null;
  interval_minutes: number;
  starts_at: string;
  ends_at: string;
  next_fire_at: string;
  last_sent_at: string | null;
  active: boolean;
  task_id: string | null;
  created_at: string;
  updated_at: string;
}

/** A reminder with its linked task resolved: null when it has none, or the task is gone or foreign. */
export interface ReminderWithTask extends Reminder {
  task: EmbeddedTask | null;
}

/** `user_id` is deliberately not writable here: it always comes from the session. */
export type ReminderWrite = Partial<
  Pick<Reminder, 'title' | 'message' | 'interval_minutes' | 'starts_at' | 'ends_at' | 'next_fire_at' | 'active' | 'task_id'>
>;

const TABLE = 'moodle_custom_reminders';
const FAILURE = 'No se pudieron cargar los recordatorios.';
const TASK_COLUMNS = 'select=id,title,course,due_date_str,due_timestamp,task_url,status,user_id';

const rest = <T>(query: string, init: RequestInit = {}) =>
  dbJson<T>(`${TABLE}${query}`, { ...init, headers: { Prefer: 'return=representation', ...init.headers } });

export { isUuid };

export function listReminders(userId: string): Promise<Reminder[]> {
  return rest<Reminder[]>(scopedQuery(userId, 'select=*', 'order=next_fire_at.asc'));
}

type RawRow = Reminder & { task?: unknown };

const resolveTask = (userId: string, row: RawRow): ReminderWithTask => ({
  ...row,
  task: row.task_id ? ownedEmbeddedTask(row.task, userId) : null,
});

/** An answered 4xx on the embedded read means the join was rejected (older schema); outages are not retried. */
const embedRejected = (error: unknown) => error instanceof DbReadError && error.status >= 400 && error.status < 500;

/** Degraded path only (embed unavailable): resolves the linked tasks with one extra owner-scoped read. */
async function attachTasks(userId: string, rows: Reminder[]): Promise<ReminderWithTask[]> {
  const ids = rows.map((r) => r.task_id).filter((id): id is string => !!id);
  let tasks: EmbeddedTask[] = [];
  if (ids.length > 0) {
    tasks = await dbJson<EmbeddedTask[]>(`moodle_tasks${ownedTasksInQuery(userId, ids, TASK_COLUMNS)}`, {}, FAILURE).catch(
      () => [],
    );
  }
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return rows.map((r) => resolveTask(userId, { ...r, task: r.task_id ? byId.get(r.task_id) : null }));
}

export interface ReminderPage {
  reminders: ReminderWithTask[];
  total: number;
  page: number;
}

async function readPage(userId: string, page: number): Promise<{ reminders: ReminderWithTask[]; total: number }> {
  try {
    const { rows, total } = await dbRead<RawRow>(`${TABLE}${reminderPageQuery(userId, page, true)}`, FAILURE, true);
    return { reminders: rows.map((r) => resolveTask(userId, r)), total };
  } catch (error) {
    if (!embedRejected(error)) throw error;
    const { rows, total } = await dbRead<Reminder>(`${TABLE}${reminderPageQuery(userId, page)}`, FAILURE, true);
    return { reminders: await attachTasks(userId, rows), total };
  }
}

/**
 * One page of reminders (8 per page) with their linked tasks embedded, plus the exact total of reminders.
 * An out-of-range page falls back to the last one.
 */
export async function listRemindersPage(userId: string, page: number): Promise<ReminderPage> {
  const first = await readPage(userId, page);
  const served = clampPage(page, first.total);
  if (served === page) return { ...first, page };
  const again = await readPage(userId, served);
  return { ...again, page: served };
}

export async function getReminder(userId: string, id: string): Promise<Reminder | null> {
  if (!isUuid(id)) return null;
  const rows = await rest<Reminder[]>(ownedRowQuery(userId, id, 'select=*', 'limit=1'));
  return rows[0] ?? null;
}

/** One reminder with its linked task embedded (for the edit form), in a single round trip. */
export async function getReminderWithTask(userId: string, id: string): Promise<ReminderWithTask | null> {
  if (!isUuid(id)) return null;
  try {
    const { rows } = await dbRead<RawRow>(`${TABLE}${reminderRowQuery(userId, id, true)}`, FAILURE);
    return rows[0] ? resolveTask(userId, rows[0]) : null;
  } catch (error) {
    if (!embedRejected(error)) throw error;
    const { rows } = await dbRead<Reminder>(`${TABLE}${reminderRowQuery(userId, id)}`, FAILURE);
    return rows[0] ? (await attachTasks(userId, [rows[0]]))[0] : null;
  }
}

export async function createReminder(userId: string, data: ReminderWrite): Promise<Reminder> {
  const rows = await rest<Reminder[]>('', { method: 'POST', body: JSON.stringify({ ...data, user_id: userId }) });
  return rows[0];
}

export async function updateReminder(userId: string, id: string, data: ReminderWrite): Promise<Reminder | null> {
  if (!isUuid(id)) return null;
  const rows = await rest<Reminder[]>(ownedRowQuery(userId, id), {
    method: 'PATCH',
    body: JSON.stringify({ ...data, updated_at: new Date().toISOString() }),
  });
  return rows[0] ?? null;
}

/**
 * Writes `data` only while the row still has `currentActive` (`active=eq.<currentActive>`), so a double tap
 * or a second tab cannot flip a pause/resume back. Returns false when nothing matched.
 */
export async function updateReminderIfActive(
  userId: string,
  id: string,
  currentActive: boolean,
  data: ReminderWrite,
): Promise<boolean> {
  if (!isUuid(id)) return false;
  const rows = await rest<Reminder[]>(reminderActiveFilter(userId, id, currentActive), {
    method: 'PATCH',
    body: JSON.stringify({ ...data, updated_at: new Date().toISOString() }),
  });
  return rows.length > 0;
}

export async function deleteReminder(userId: string, id: string): Promise<void> {
  if (!isUuid(id)) return;
  await rest<Reminder[]>(ownedRowQuery(userId, id), { method: 'DELETE' });
}
