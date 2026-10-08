import 'server-only';
import { dbFetch } from './db';
import { clampPage, parseContentRange } from './pagination';
import { isMissingColumnError } from './push-query';
import {
  HISTORY_COLUMNS,
  HISTORY_COLUMNS_LEGACY,
  HISTORY_PAGE_SIZE,
  HISTORY_TABLE,
  clearHistoryQuery,
  historyPageQuery,
  notificationRowQuery,
  type HistoryFilter,
  type NotificationLogRow,
} from './notification-log';

export interface HistoryPage {
  rows: NotificationLogRow[];
  total: number;
  page: number;
  /** False while the worker migration that creates `moodle_notification_log` has not been applied yet. */
  available: boolean;
}

// PostgREST answers 404 (PGRST205 / 42P01) for a relation that does not exist.
const TABLE_MISSING = 404;

// `push_state` is newer than the table. Once PostgREST says it does not exist, this server instance stops
// asking for it (the next deploy, after the migration, starts over).
let pushStateColumn = true;

/** Runs a history read, retrying once without `push_state` when the column does not exist yet. */
async function fetchHistory(build: (columns: string) => string, init?: RequestInit): Promise<Response> {
  const res = await dbFetch(build(pushStateColumn ? HISTORY_COLUMNS : HISTORY_COLUMNS_LEGACY), init);
  if (res.status !== 400 || !pushStateColumn) return res;
  if (!isMissingColumnError(res.status, await res.clone().text())) return res;
  pushStateColumn = false;
  return dbFetch(build(HISTORY_COLUMNS_LEGACY), init);
}

async function readPage(userId: string, filter: HistoryFilter, page: number) {
  const res = await fetchHistory((columns) => `${HISTORY_TABLE}${historyPageQuery(userId, filter, page, columns)}`, {
    headers: { Prefer: 'count=exact' },
  });
  if (res.status === TABLE_MISSING) return { missing: true as const };
  const total = parseContentRange(res.headers.get('content-range'));
  // 416: offset past the end. Report an empty page with the real total so the caller can clamp.
  if (res.status === 416) return { missing: false as const, rows: [] as NotificationLogRow[], total: total ?? 0 };
  if (!res.ok) {
    // Status only: error bodies can echo row data.
    console.error('Supabase request failed', res.status);
    throw new Error('No se pudo cargar el historial.');
  }
  const text = await res.text();
  const rows = (text ? JSON.parse(text) : []) as NotificationLogRow[];
  return { missing: false as const, rows, total: total ?? rows.length };
}

/** One page of the session user's history; an out-of-range page falls back to the last one. */
export async function listHistoryPage(userId: string, filter: HistoryFilter, page: number): Promise<HistoryPage> {
  const first = await readPage(userId, filter, page);
  if (first.missing) return { rows: [], total: 0, page: 1, available: false };
  const served = clampPage(page, first.total, HISTORY_PAGE_SIZE);
  if (served === page) return { rows: first.rows, total: first.total, page, available: true };
  const again = await readPage(userId, filter, served);
  if (again.missing) return { rows: [], total: 0, page: 1, available: false };
  return { rows: again.rows, total: again.total, page: served, available: true };
}

/** The session user's history row `id` (the notification they tapped), or null when it is gone, not theirs, or the table is missing. */
export async function getHistoryEntry(userId: string, id: string): Promise<NotificationLogRow | null> {
  const res = await fetchHistory((columns) => `${HISTORY_TABLE}${notificationRowQuery(userId, id, columns)}`);
  if (res.status === TABLE_MISSING) return null;
  if (!res.ok) {
    console.error('Supabase request failed', res.status);
    throw new Error('No se pudo cargar el aviso.');
  }
  const text = await res.text();
  const rows = (text ? JSON.parse(text) : []) as NotificationLogRow[];
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

/** Deletes every history row of the session user. A missing table is not an error: there is nothing to clear. */
export async function clearHistory(userId: string): Promise<void> {
  const res = await dbFetch(`${HISTORY_TABLE}${clearHistoryQuery(userId)}`, { method: 'DELETE' });
  if (res.ok || res.status === TABLE_MISSING) return;
  console.error('Supabase request failed', res.status);
  throw new Error('No se pudo borrar el historial.');
}
