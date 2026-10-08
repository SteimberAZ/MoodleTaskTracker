import 'server-only';
import { dbFetch } from './db';
import { isMissingColumnError } from './push-query';
import { userRowQuery } from './queries';
import { resolveNtfyEnabled } from './ntfy';

/**
 * ntfy delivery state of the session user: the `ntfy_enabled` switch plus `ntfy_confirmed_at`, set once the
 * user proved they receive ntfy (a successful "Probar ntfy" or "Ya me suscribí"). The worker only counts ntfy
 * as delivered when it is confirmed. `ntfy_confirmed_at` is newer than the table: while it is missing,
 * `confirmationSupported` is false and the page hides the confirmation controls.
 */
export interface NtfyStatus {
  enabled: boolean;
  confirmedAt: string | null;
  confirmationSupported: boolean;
}

export function ntfyStatusQuery(userId: string, withConfirmation = true): string {
  return userRowQuery(userId, `select=${withConfirmation ? 'ntfy_enabled,ntfy_confirmed_at' : 'ntfy_enabled'}`, 'limit=1');
}

/** `PATCH moodle_users?id=eq.<me>` setting `ntfy_confirmed_at` (the row is always the session user's). */
export function ntfyConfirmRequest(
  userId: string,
  confirmedAt: string | null,
): { query: string; body: { ntfy_confirmed_at: string | null } } {
  return { query: userRowQuery(userId, 'select=id'), body: { ntfy_confirmed_at: confirmedAt } };
}

type Row = { ntfy_enabled?: boolean | null; ntfy_confirmed_at?: string | null };

/** Never throws: any read error falls back to "enabled, unconfirmed, confirmation unsupported". */
export async function getNtfyStatus(userId: string): Promise<NtfyStatus> {
  try {
    let res = await dbFetch(`moodle_users${ntfyStatusQuery(userId)}`);
    let text = await res.text();
    let confirmationSupported = true;
    if (!res.ok && isMissingColumnError(res.status, text)) {
      confirmationSupported = false;
      res = await dbFetch(`moodle_users${ntfyStatusQuery(userId, false)}`);
      text = await res.text();
    }
    if (!res.ok) throw new Error(String(res.status));
    const rows = (text ? JSON.parse(text) : []) as Row[];
    return {
      enabled: resolveNtfyEnabled(rows),
      confirmedAt: confirmationSupported ? (rows[0]?.ntfy_confirmed_at ?? null) : null,
      confirmationSupported,
    };
  } catch {
    return { enabled: true, confirmedAt: null, confirmationSupported: false };
  }
}

/**
 * Marks the user's ntfy as confirmed now (or clears it with `confirmed` false, e.g. after a new topic).
 * 'unsupported' when the column does not exist yet (ignored by callers), false when the write failed or
 * matched no row.
 */
export async function confirmNtfy(userId: string, confirmed = true): Promise<true | false | 'unsupported'> {
  const { query, body } = ntfyConfirmRequest(userId, confirmed ? new Date().toISOString() : null);
  try {
    const res = await dbFetch(`moodle_users${query}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      if (isMissingColumnError(res.status, text)) return 'unsupported';
      console.error('Confirming ntfy failed', res.status);
      return false;
    }
    const rows = (text ? JSON.parse(text) : []) as unknown[];
    return Array.isArray(rows) && rows.length > 0;
  } catch {
    return false;
  }
}
