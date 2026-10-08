import 'server-only';
import { dbFetch, dbJson } from './db';
import type { ValidSubscription } from './push';
import {
  PUSH_OWNERS_PATH,
  countByOwner,
  pushDeletePath,
  pushTestRequest,
  pushUpsertRequest,
  type PushMeta,
} from './push-query';

/** Stores or refreshes one device of the user. Throws on any database failure. */
export async function savePushSubscription(userId: string, sub: ValidSubscription, meta: Omit<PushMeta, 'nowIso'>): Promise<void> {
  const { path, headers, body } = pushUpsertRequest(userId, sub, { ...meta, nowIso: new Date().toISOString() });
  const res = await dbFetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    // Status only: the response can echo the row (keys).
    console.error('Saving push subscription failed', res.status);
    throw new Error('No se pudo guardar la suscripción.');
  }
}

/** Deletes one device, only when it belongs to the user. */
export async function removePushSubscription(userId: string, endpoint: string): Promise<void> {
  const res = await dbFetch(pushDeletePath(userId, endpoint), { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  if (!res.ok) {
    console.error('Removing push subscription failed', res.status);
    throw new Error('No se pudo quitar la suscripción.');
  }
}

/** Marks a device so the worker sends it a test push. False when the device is not registered for this user. */
export async function requestPushTest(userId: string, endpoint: string): Promise<boolean> {
  const { path, body } = pushTestRequest(userId, endpoint, new Date().toISOString());
  const rows = await dbJson<{ id: string }[]>(
    path,
    { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(body) },
    'No se pudo solicitar la prueba.',
  );
  return rows.length > 0;
}

/** Devices per user for the admin page, or null when the table cannot be read (migration pending). */
export async function countPushDevicesByUser(): Promise<Map<string, number> | null> {
  try {
    return countByOwner(await dbJson<{ user_id: string }[]>(PUSH_OWNERS_PATH));
  } catch {
    return null;
  }
}
