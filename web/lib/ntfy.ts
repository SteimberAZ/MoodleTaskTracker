import { userRowQuery } from './queries';

/** Pure builders for the per-user "also deliver through ntfy" switch (`moodle_users.ntfy_enabled`). */

/** Read of the flag for the session user. */
export function ntfyEnabledQuery(userId: string): string {
  return userRowQuery(userId, 'select=ntfy_enabled', 'limit=1');
}

/** `PATCH moodle_users?id=eq.<me>`: the row is always the session user's, never one taken from input. */
export function ntfyEnabledRequest(
  userId: string,
  enabled: boolean,
  nowIso: string,
): { query: string; body: { ntfy_enabled: boolean; updated_at: string } } {
  return { query: userRowQuery(userId, 'select=id'), body: { ntfy_enabled: enabled, updated_at: nowIso } };
}

/** The flag defaults to true: a missing column, missing row or null value all mean "enabled". */
export function resolveNtfyEnabled(rows: { ntfy_enabled?: boolean | null }[] | null | undefined): boolean {
  return rows?.[0]?.ntfy_enabled !== false;
}
