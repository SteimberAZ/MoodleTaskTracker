import 'server-only';
import { dbJson } from './db';
import { isUuid, ownedRowQuery, scopedQuery } from './queries';

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

/** `user_id` is deliberately not writable here: it always comes from the session. */
export type ReminderWrite = Partial<
  Pick<Reminder, 'title' | 'message' | 'interval_minutes' | 'starts_at' | 'ends_at' | 'next_fire_at' | 'active' | 'task_id'>
>;

const TABLE = 'moodle_custom_reminders';

const rest = <T>(query: string, init: RequestInit = {}) =>
  dbJson<T>(`${TABLE}${query}`, { ...init, headers: { Prefer: 'return=representation', ...init.headers } });

export { isUuid };

export function listReminders(userId: string): Promise<Reminder[]> {
  return rest<Reminder[]>(scopedQuery(userId, 'select=*', 'order=next_fire_at.asc'));
}

export async function getReminder(userId: string, id: string): Promise<Reminder | null> {
  if (!isUuid(id)) return null;
  const rows = await rest<Reminder[]>(ownedRowQuery(userId, id, 'select=*', 'limit=1'));
  return rows[0] ?? null;
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

export async function deleteReminder(userId: string, id: string): Promise<void> {
  if (!isUuid(id)) return;
  await rest<Reminder[]>(ownedRowQuery(userId, id), { method: 'DELETE' });
}
