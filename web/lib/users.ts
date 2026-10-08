import 'server-only';
import { dbFetch, dbJson } from './db';
import { isUuid } from './queries';

/**
 * Users as seen by the web app. The `token` column is deliberately never selected: it is
 * only written at login (see `login-store.ts`) and read by the worker.
 */
export interface SessionUser {
  id: string;
  username: string;
  fullname: string | null;
  ntfy_topic: string;
  is_admin: boolean;
  active: boolean;
  last_error: string | null;
}

export interface AdminUserRow {
  id: string;
  username: string;
  fullname: string | null;
  created_at: string;
  last_login_at: string | null;
  last_error: string | null;
  is_admin: boolean;
  active: boolean;
}

const SESSION_COLUMNS = 'id,username,fullname,ntfy_topic,is_admin,active,last_error';
const ADMIN_COLUMNS = 'id,username,fullname,created_at,last_login_at,last_error,is_admin,active';

export async function getUserById(id: string): Promise<SessionUser | null> {
  if (!isUuid(id)) return null;
  const rows = await dbJson<SessionUser[]>(`moodle_users?select=${SESSION_COLUMNS}&id=eq.${id}&limit=1`);
  return rows[0] ?? null;
}

export function listUsersForAdmin(): Promise<AdminUserRow[]> {
  return dbJson<AdminUserRow[]>(
    `moodle_users?select=${ADMIN_COLUMNS}&order=created_at.asc`,
    {},
    'No se pudieron cargar los usuarios.',
  );
}

export async function setUserActive(id: string, active: boolean): Promise<void> {
  if (!isUuid(id)) return;
  await dbJson<unknown>(
    `moodle_users?id=eq.${id}`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ active, updated_at: new Date().toISOString() }),
    },
    'No se pudo actualizar el usuario.',
  );
}

/** Returns false when the topic collides with another user's (unique constraint). */
export async function setUserTopic(id: string, topic: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  const res = await dbFetch(`moodle_users?id=eq.${id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ ntfy_topic: topic, updated_at: new Date().toISOString() }),
  });
  if (res.status === 409) return false;
  if (!res.ok) {
    console.error('Updating ntfy topic failed', res.status);
    throw new Error('No se pudo actualizar el tema.');
  }
  return true;
}
