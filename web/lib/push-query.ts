import type { Platform } from './platform';
import { isPlausibleEndpoint, type ValidSubscription } from './push';
import { scopedQuery, userFilter } from './queries';

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

/**
 * Upsert by endpoint: a device that logs in as another user is moved to that user, and re-posting an
 * unchanged subscription only refreshes `updated_at`. `failure_count` and the worker's timestamps are not touched.
 */
export function pushUpsertRequest(
  userId: string,
  sub: ValidSubscription,
  meta: PushMeta,
): { path: string; headers: { Prefer: string }; body: Record<string, unknown> } {
  userFilter(userId); // throws unless it is a UUID
  return {
    path: `${PUSH_TABLE}?on_conflict=endpoint`,
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: {
      user_id: userId,
      endpoint: sub.endpoint,
      p256dh: sub.p256dh,
      auth: sub.auth,
      user_agent: meta.userAgent,
      platform: meta.platform,
      updated_at: meta.nowIso,
    },
  };
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
