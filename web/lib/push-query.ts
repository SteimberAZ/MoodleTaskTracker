import type { Platform } from './platform';
import { deliveryFailing, isPlausibleEndpoint, type PushServerStatus, type ValidSubscription } from './push';
import { isUuid, scopedQuery, userFilter } from './queries';

/**
 * Pure builders for `moodle_push_subscriptions`. The owner always comes from the verified session and is
 * part of every filter and every written row, so one user can never read, move or delete another's device.
 */
export const PUSH_TABLE = 'moodle_push_subscriptions';

export interface PushMeta {
  userAgent: string | null;
  platform: Platform;
  nowIso: string;
}

/** Devices kept per user: older rows (by `updated_at`) are deleted after every save. */
export const MAX_DEVICES_PER_USER = 10;

/**
 * Upsert by endpoint: a device that logs in as another user is moved to that user, and re-posting an
 * unchanged subscription only refreshes `updated_at`. `failure_count` and the worker's timestamps are not
 * touched, except that an explicit activation (`resetFailures`) starts the device over at `failure_count = 0`
 * with no `last_failure_at`, so an old rejection does not keep the fresh device flagged as failing.
 */
export function pushUpsertRequest(
  userId: string,
  sub: ValidSubscription,
  meta: PushMeta,
  options: { resetFailures?: boolean } = {},
): { path: string; headers: { Prefer: string }; body: Record<string, unknown> } {
  userFilter(userId); // throws unless it is a UUID
  const body: Record<string, unknown> = {
    user_id: userId,
    endpoint: sub.endpoint,
    p256dh: sub.p256dh,
    auth: sub.auth,
    user_agent: meta.userAgent,
    platform: meta.platform,
    updated_at: meta.nowIso,
  };
  if (options.resetFailures) {
    body.failure_count = 0;
    body.last_failure_at = null;
  }
  return {
    path: `${PUSH_TABLE}?on_conflict=endpoint`,
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body,
  };
}

/** Ids of the user's devices beyond the newest `MAX_DEVICES_PER_USER` (by `updated_at`). */
export function pushOverflowPath(userId: string, keep = MAX_DEVICES_PER_USER): string {
  return `${PUSH_TABLE}${scopedQuery(userId, 'select=id', 'order=updated_at.desc,id.desc', `offset=${keep}`, 'limit=1000')}`;
}

/** `DELETE` of several devices of the user by id (ids that are not UUIDs are dropped); null when nothing is left. */
export function pushDeleteIdsPath(userId: string, ids: string[]): string | null {
  const safe = [...new Set(ids)].filter(isUuid);
  if (safe.length === 0) return null;
  return `${PUSH_TABLE}${scopedQuery(userId, `id=in.(${safe.join(',')})`)}`;
}

/** How many devices the user has (for the "no devices" notice): only ids are read. */
export function pushUserDevicesPath(userId: string): string {
  return `${PUSH_TABLE}${scopedQuery(userId, 'select=id', `limit=${MAX_DEVICES_PER_USER + 1}`)}`;
}

/* ------------------------------------------------------------------------- */
/* Device health (POST /api/push/status and the admin page)                   */
/* ------------------------------------------------------------------------- */

const STATUS_BASE = 'last_success_at,last_failure_at,failure_count,test_requested_at';
// `last_failure_reason` is newer than the table: every read that selects it has a fallback without it.
const REASON = 'last_failure_reason';

/** One device of the session user with its delivery health. `withReason` false is the fallback before the migration. */
export function pushStatusPath(userId: string, endpoint: string, withReason = true): string {
  const columns = withReason ? `${STATUS_BASE},${REASON}` : STATUS_BASE;
  return `${PUSH_TABLE}${pushEndpointQuery(userId, endpoint, `select=${columns}`, 'limit=1')}`;
}

export interface PushStatusRow {
  last_success_at?: string | null;
  last_failure_at?: string | null;
  failure_count?: number | null;
  last_failure_reason?: string | null;
  test_requested_at?: string | null;
}

/** The `POST /api/push/status` answer for the rows read: `registered` false (and every field null) when there is none. */
export function pushStatusFromRows(rows: PushStatusRow[] | null | undefined): PushServerStatus {
  const row = Array.isArray(rows) ? rows[0] : undefined;
  return {
    registered: !!row,
    last_success_at: row?.last_success_at ?? null,
    last_failure_at: row?.last_failure_at ?? null,
    failure_count: Number(row?.failure_count) > 0 ? Number(row?.failure_count) : 0,
    last_failure_reason: row?.last_failure_reason ?? null,
    test_requested_at: row?.test_requested_at ?? null,
  };
}

/** Admin overview: every device with its owner and delivery health (`withReason` false before the migration). */
export function pushHealthPath(withReason = true): string {
  const columns = `id,user_id,platform,updated_at,${STATUS_BASE}${withReason ? `,${REASON}` : ''}`;
  return `${PUSH_TABLE}?select=${columns}&order=updated_at.desc&limit=10000`;
}

export interface PushDeviceHealth {
  id: string;
  user_id: string;
  platform: string | null;
  updated_at: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  failure_count: number | null;
  last_failure_reason?: string | null;
  test_requested_at: string | null;
}

const PLATFORM_LABELS: Record<string, string> = { ios: 'iPhone/iPad', android: 'Android', desktop: 'Computadora' };

/** Short name of a device for the admin list ("Android", "Computadora", "Dispositivo"). */
export function devicePlatformLabel(platform: string | null | undefined): string {
  return (platform && PLATFORM_LABELS[platform]) || 'Dispositivo';
}

/** True when the newest event of a device is a failure (same rule as the device card on /notificaciones). */
export function deviceFailing(
  device: Pick<PushDeviceHealth, 'last_failure_at' | 'last_success_at'> & { failure_count?: number | null },
): boolean {
  return deliveryFailing({
    last_failure_at: device.last_failure_at,
    last_success_at: device.last_success_at,
  });
}

export function groupByOwner<T extends { user_id: string }>(rows: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const list = groups.get(row.user_id);
    if (list) list.push(row);
    else groups.set(row.user_id, [row]);
  }
  return groups;
}

/**
 * PostgREST's answer to a select or write naming a column that does not exist yet (42703 from Postgres, or
 * PGRST204 from the schema cache). Callers then retry without the newer column instead of failing the page.
 */
export function isMissingColumnError(status: number, bodyText: string | null | undefined): boolean {
  if (status !== 400 || !bodyText) return false;
  try {
    const code = (JSON.parse(bodyText) as { code?: unknown }).code;
    return code === '42703' || code === 'PGRST204';
  } catch {
    return false;
  }
}

/** `?user_id=eq.<me>&endpoint=eq.<endpoint>&...parts`: the only way to address one device. */
export function pushEndpointQuery(userId: string, endpoint: string, ...parts: string[]): string {
  if (!isPlausibleEndpoint(endpoint)) throw new Error('Invalid endpoint');
  return scopedQuery(userId, `endpoint=eq.${encodeURIComponent(endpoint)}`, ...parts);
}

/** `DELETE` of one device of the session user. */
export function pushDeletePath(userId: string, endpoint: string): string {
  return `${PUSH_TABLE}${pushEndpointQuery(userId, endpoint)}`;
}

/** `PATCH` asking the worker to send a test push to one device of the session user within about a minute. */
export function pushTestRequest(
  userId: string,
  endpoint: string,
  nowIso: string,
): { path: string; body: { test_requested_at: string } } {
  return { path: `${PUSH_TABLE}${pushEndpointQuery(userId, endpoint, 'select=id')}`, body: { test_requested_at: nowIso } };
}

/** Admin overview: every subscription's owner (counted in memory, no aggregates needed). */
export const PUSH_OWNERS_PATH = `${PUSH_TABLE}?select=user_id&limit=10000`;

export function countByOwner(rows: { user_id: string }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { user_id } of rows) counts.set(user_id, (counts.get(user_id) ?? 0) + 1);
  return counts;
}

/** "N dispositivo(s)" for the admin list; "—" when the table could not be read. */
export function formatDeviceCount(count: number | undefined): string {
  if (count === undefined) return '—';
  return `${count} ${count === 1 ? 'dispositivo' : 'dispositivos'}`;
}
