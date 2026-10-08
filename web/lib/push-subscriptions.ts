import 'server-only';
import { dbFetch, dbJson } from './db';
import type { PushServerStatus, ValidSubscription } from './push';
import {
  PUSH_OWNERS_PATH,
  countByOwner,
  isMissingColumnError,
  pushDeleteIdsPath,
  pushDeletePath,
  pushHealthPath,
  pushOverflowPath,
  pushStatusFromRows,
  pushStatusPath,
  pushTestRequest,
  pushUpsertRequest,
  pushUserDevicesPath,
  type PushDeviceHealth,
  type PushMeta,
  type PushStatusRow,
} from './push-query';

/**
 * Stores or refreshes one device of the user, then deletes that user's devices beyond the newest ten.
 * `resetFailures` (explicit activation only) starts the device over at `failure_count = 0`.
 * Throws when the device cannot be saved; a failed cleanup of old devices is only logged.
 */
export async function savePushSubscription(
  userId: string,
  sub: ValidSubscription,
  meta: Omit<PushMeta, 'nowIso'>,
  options: { resetFailures?: boolean } = {},
): Promise<void> {
  const { path, headers, body } = pushUpsertRequest(userId, sub, { ...meta, nowIso: new Date().toISOString() }, options);
  const res = await dbFetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    // Status only: the response can echo the row (keys).
    console.error('Saving push subscription failed', res.status);
    throw new Error('No se pudo guardar la suscripción.');
  }
  await pruneOldDevices(userId);
}

/** Keeps at most ten devices per user so a flood of stale subscriptions cannot slow every delivery down. */
async function pruneOldDevices(userId: string): Promise<void> {
  try {
    const extra = await dbJson<{ id: string }[]>(pushOverflowPath(userId));
    const path = pushDeleteIdsPath(userId, extra.map((row) => row.id));
    if (!path) return;
    const res = await dbFetch(path, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    if (!res.ok) console.error('Pruning push subscriptions failed', res.status);
  } catch {
    console.error('Pruning push subscriptions failed');
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
export async function requestPushTest(userId: string, endpoint: string, nowIso = new Date().toISOString()): Promise<boolean> {
  const { path, body } = pushTestRequest(userId, endpoint, nowIso);
  const rows = await dbJson<{ id: string }[]>(
    path,
    { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(body) },
    'No se pudo solicitar la prueba.',
  );
  return rows.length > 0;
}

/**
 * Reads a select that may name a column added by a later migration: when PostgREST says the column does not
 * exist, the fallback path (without it) is read instead. Any other failure throws.
 */
async function readWithFallback<T>(path: string, fallback: string, failure: string): Promise<T[]> {
  for (const candidate of [path, fallback]) {
    const res = await dbFetch(candidate);
    const text = await res.text();
    if (res.ok) return (text ? JSON.parse(text) : []) as T[];
    if (candidate === path && isMissingColumnError(res.status, text)) continue;
    // Status only: error bodies can echo row data.
    console.error('Supabase request failed', res.status);
    throw new Error(failure);
  }
  return [];
}

/** What the server knows about one device of the user (`registered` false when it has no row for it). */
export async function getPushStatus(userId: string, endpoint: string): Promise<PushServerStatus> {
  const rows = await readWithFallback<PushStatusRow>(
    pushStatusPath(userId, endpoint, true),
    pushStatusPath(userId, endpoint, false),
    'No se pudo leer el estado del dispositivo.',
  );
  return pushStatusFromRows(rows);
}

/** Number of devices the user has registered (capped at 11), or null when it cannot be read. */
export async function countUserPushDevices(userId: string): Promise<number | null> {
  try {
    return (await dbJson<{ id: string }[]>(pushUserDevicesPath(userId))).length;
  } catch {
    return null;
  }
}

/** Every device with its owner and delivery health, for the admin page. Throws when the table cannot be read. */
export function listPushDeviceHealth(): Promise<PushDeviceHealth[]> {
  return readWithFallback<PushDeviceHealth>(pushHealthPath(true), pushHealthPath(false), 'No se pudieron leer los dispositivos.');
}

/** Devices per user for the admin page, or null when the table cannot be read (migration pending). */
export async function countPushDevicesByUser(): Promise<Map<string, number> | null> {
  try {
    return countByOwner(await dbJson<{ user_id: string }[]>(PUSH_OWNERS_PATH));
  } catch {
    return null;
  }
}
