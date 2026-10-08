import 'server-only';
import { dbJson } from './db';

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

export type ReminderWrite = Partial<
  Pick<Reminder, 'title' | 'message' | 'interval_minutes' | 'starts_at' | 'ends_at' | 'next_fire_at' | 'active' | 'task_id'>
>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TABLE = 'moodle_custom_reminders';

const rest = <T>(query: string, init: RequestInit = {}) =>
  dbJson<T>(`${TABLE}${query}`, { ...init, headers: { Prefer: 'return=representation', ...init.headers } });

export const isUuid = (id: string) => UUID.test(id);

export function listReminders(): Promise<Reminder[]> {
  return rest<Reminder[]>('?select=*&order=next_fire_at.asc');
}

export async function getReminder(id: string): Promise<Reminder | null> {
  if (!isUuid(id)) return null;
  const rows = await rest<Reminder[]>(`?select=*&id=eq.${id}&limit=1`);
  return rows[0] ?? null;
}

export async function createReminder(data: ReminderWrite): Promise<Reminder> {
  const rows = await rest<Reminder[]>('', { method: 'POST', body: JSON.stringify(data) });
  return rows[0];
}

export async function updateReminder(id: string, data: ReminderWrite): Promise<Reminder | null> {
  if (!isUuid(id)) return null;
  const rows = await rest<Reminder[]>(`?id=eq.${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ ...data, updated_at: new Date().toISOString() }),
  });
  return rows[0] ?? null;
}

export async function deleteReminder(id: string): Promise<void> {
  if (!isUuid(id)) return;
  await rest<Reminder[]>(`?id=eq.${id}`, { method: 'DELETE' });
}
