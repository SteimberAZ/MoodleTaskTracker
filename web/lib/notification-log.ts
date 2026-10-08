import { GUAYAQUIL_OFFSET_MINUTES, formatGuayaquilShort } from './time';
import { pageRange } from './pagination';
import { isUuid, ownedRowQuery, scopedQuery } from './queries';

/**
 * Pure helpers for the notification history ("Historial de avisos") on /notificaciones:
 * query builders, filters, same-origin link check, day grouping, time labels and channel badges.
 * The data comes from `moodle_notification_log`, written by the worker.
 */
export const NOTIFICATIONS_PATH = '/notificaciones';
export const HISTORY_PAGE_SIZE = 20;
export const HISTORY_TABLE = 'moodle_notification_log';

export type NotificationKind = 'task' | 'reminder' | 'class' | 'status' | 'test';

export interface NotificationLogRow {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  url: string | null;
  status: string;
  push_ok: number | null;
  push_total: number | null;
  ntfy_attempted: boolean | null;
  ntfy_ok: boolean | null;
  created_at: string;
}

/** Only the columns the list renders (the `tag` and `user_id` columns are never read by the page). */
export const HISTORY_COLUMNS =
  'select=id,kind,title,body,url,status,push_ok,push_total,ntfy_attempted,ntfy_ok,created_at';

// ---------------------------------------------------------------- filters (?hk=)

export type HistoryFilter = 'todos' | 'tareas' | 'recordatorios' | 'clases' | 'sistema';

export const HISTORY_FILTERS: readonly { value: HistoryFilter; label: string }[] = [
  { value: 'todos', label: 'Todos' },
  { value: 'tareas', label: 'Tareas' },
  { value: 'recordatorios', label: 'Recordatorios' },
  { value: 'clases', label: 'Clases' },
  { value: 'sistema', label: 'Sistema' },
];

export const DEFAULT_HISTORY_FILTER: HistoryFilter = 'todos';

export function parseHistoryFilter(raw: string | string[] | undefined | null): HistoryFilter {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return HISTORY_FILTERS.some((f) => f.value === value) ? (value as HistoryFilter) : DEFAULT_HISTORY_FILTER;
}

/** PostgREST `kind` filter of a chip; `Sistema` groups the worker status alerts and the push tests. */
export function historyKindParts(filter: HistoryFilter): string[] {
  switch (filter) {
    case 'tareas':
      return ['kind=eq.task'];
    case 'recordatorios':
      return ['kind=eq.reminder'];
    case 'clases':
      return ['kind=eq.class'];
    case 'sistema':
      return ['kind=in.(status,test)'];
    default:
      return [];
  }
}

// ---------------------------------------------------------------- queries

/** One page of history, newest first, always scoped to the session user. */
export function historyPageQuery(userId: string, filter: HistoryFilter, page: number): string {
  const { limit, offset } = pageRange(page, HISTORY_PAGE_SIZE);
  return scopedQuery(
    userId,
    HISTORY_COLUMNS,
    ...historyKindParts(filter),
    'order=created_at.desc,id.desc',
    `limit=${limit}`,
    `offset=${offset}`,
  );
}

/** `DELETE moodle_notification_log?user_id=eq.<me>`: clears the whole history of the session user, nobody else's. */
export function clearHistoryQuery(userId: string): string {
  return scopedQuery(userId);
}

export interface HistoryParams {
  hk?: HistoryFilter;
  hp?: number;
}

/** `/notificaciones` link carrying the non-default filter and page; `anchor` keeps the scroll on the history. */
export function notificationsHref(params: HistoryParams, anchor?: 'historial'): string {
  const query = new URLSearchParams();
  if (params.hk && params.hk !== DEFAULT_HISTORY_FILTER) query.set('hk', params.hk);
  if (params.hp && params.hp > 1) query.set('hp', String(params.hp));
  const qs = query.toString();
  return `${NOTIFICATIONS_PATH}${qs ? `?${qs}` : ''}${anchor ? `#${anchor}` : ''}`;
}

// ---------------------------------------------------------------- opened from a notification (?n=)

/**
 * Tapping a push opens `/notificaciones?n=<history row id>`. Only a well-formed uuid is accepted (the
 * first value when repeated); anything else is ignored so it can never reach a query.
 */
export function parseNotificationParam(raw: string | string[] | undefined | null): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && isUuid(value) ? value.toLowerCase() : null;
}

/** One history row of the session user by id: `?user_id=eq.<me>&id=eq.<uuid>&select=...&limit=1`. Another user's row never matches. */
export function notificationRowQuery(userId: string, id: string): string {
  return ownedRowQuery(userId, id, HISTORY_COLUMNS, 'limit=1');
}

/** DOM id of a history entry; the opened notification is scrolled to and highlighted through it. */
export function notificationDomId(id: string): string {
  return `n-${id}`;
}

// ---------------------------------------------------------------- links

/**
 * The stored `url` is a relative path chosen by the worker. It only becomes a link when it is a
 * same-origin path ("/tareas/<id>"); absolute URLs, protocol-relative ("//host"), backslashes and
 * scheme tricks ("javascript:") are rendered as plain text.
 */
export function safeNotificationHref(url: string | null | undefined): string | null {
  if (typeof url !== 'string' || url.length === 0 || url.length > 500) return null;
  if (!url.startsWith('/') || url.startsWith('//')) return null;
  if (/[\\\s\u0000-\u001f\u007f]/.test(url)) return null;
  try {
    if (new URL(url, 'https://app.invalid').origin !== 'https://app.invalid') return null;
  } catch {
    return null;
  }
  return url;
}

/** Where the "Abrir" button of an opened notification goes: its safe same-origin page, never Avisos itself (nothing to open). */
export function notificationTargetHref(url: string | null | undefined): string | null {
  const href = safeNotificationHref(url);
  if (!href) return null;
  return href.split(/[?#]/)[0] === NOTIFICATIONS_PATH ? null : href;
}

// ---------------------------------------------------------------- kinds

export function kindLabel(kind: string): string {
  switch (kind) {
    case 'task':
      return 'Tarea';
    case 'reminder':
      return 'Recordatorio';
    case 'class':
      return 'Clase';
    case 'status':
      return 'Sistema';
    case 'test':
      return 'Prueba';
    default:
      return 'Aviso';
  }
}

/** About two lines of body on a phone; anything longer gets the "Ver más" toggle. */
export const BODY_PREVIEW_CHARS = 70;

/** Long bodies get a "Ver más" toggle; short ones are shown whole. */
export function bodyIsLong(body: string | null | undefined): boolean {
  if (!body) return false;
  return body.length > BODY_PREVIEW_CHARS || body.split('\n').length > 2;
}

// ---------------------------------------------------------------- time (America/Guayaquil, UTC-5, no DST)

const OFFSET_MS = GUAYAQUIL_OFFSET_MINUTES * 60_000;
const DAY_MS = 86_400_000;
const pad = (n: number) => String(n).padStart(2, '0');
const WEEKDAYS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];

/** Whole days since the epoch of the Ecuador calendar date of `ms`; NaN for an invalid instant. */
function ecuadorDay(ms: number): number {
  return Number.isFinite(ms) ? Math.floor((ms + OFFSET_MS) / DAY_MS) : Number.NaN;
}

function hhmm(ms: number): string {
  const g = new Date(ms + OFFSET_MS);
  return `${pad(g.getUTCHours())}:${pad(g.getUTCMinutes())}`;
}

/** "hoy 07:30", "ayer 21:10", otherwise "06/10 22:05" (Ecuador time). */
export function notificationTimeLabel(iso: string, now: Date): string {
  const ms = Date.parse(iso);
  const day = ecuadorDay(ms);
  if (Number.isNaN(day)) return '—';
  const diff = ecuadorDay(now.getTime()) - day;
  if (diff === 0) return `hoy ${hhmm(ms)}`;
  if (diff === 1) return `ayer ${hhmm(ms)}`;
  return formatGuayaquilShort(ms / 1000);
}

/** "ahora", "hace 5 min", "hace 3 h", "hace 2 d"; null once it is older than a month (the date says enough). */
export function relativeLabel(iso: string, now: Date): string | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const minutes = Math.floor((now.getTime() - ms) / 60_000);
  if (minutes < 1) return 'ahora';
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `hace ${days} d` : null;
}

/** Day header: "Hoy", "Ayer", otherwise "lun 05/10" (the year is added when it is not the current one). */
export function dayHeaderLabel(iso: string, now: Date): string {
  const ms = Date.parse(iso);
  const day = ecuadorDay(ms);
  if (Number.isNaN(day)) return 'Fecha desconocida';
  const diff = ecuadorDay(now.getTime()) - day;
  if (diff === 0) return 'Hoy';
  if (diff === 1) return 'Ayer';
  const g = new Date(ms + OFFSET_MS);
  const sameYear = g.getUTCFullYear() === new Date(now.getTime() + OFFSET_MS).getUTCFullYear();
  const date = `${pad(g.getUTCDate())}/${pad(g.getUTCMonth() + 1)}${sameYear ? '' : `/${g.getUTCFullYear()}`}`;
  return `${WEEKDAYS[g.getUTCDay()]} ${date}`;
}

export interface DayGroup<T> {
  /** Ecuador calendar day ("2026-10-06"), or "unknown" for rows without a valid date. */
  key: string;
  label: string;
  items: T[];
}

/** Groups already-sorted rows into consecutive Ecuador days, keeping the incoming order. */
export function groupByDay<T extends { created_at: string }>(rows: T[], now: Date): DayGroup<T>[] {
  const groups: DayGroup<T>[] = [];
  for (const row of rows) {
    const ms = Date.parse(row.created_at);
    const day = ecuadorDay(ms);
    const key = Number.isNaN(day) ? 'unknown' : new Date(day * DAY_MS).toISOString().slice(0, 10);
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.items.push(row);
    } else {
      groups.push({ key, label: dayHeaderLabel(row.created_at, now), items: [row] });
    }
  }
  return groups;
}

// ---------------------------------------------------------------- channel badges

export type BadgeTone = 'activo' | 'urgente';

export interface ChannelBadge {
  key: 'status' | 'push' | 'ntfy';
  /** Visible text. */
  text: string;
  /** Fuller text for screen readers, when the visible one is terse. */
  srText?: string;
  tone: BadgeTone;
}

const count = (value: number | null | undefined) => (Number.isFinite(value) && (value as number) > 0 ? (value as number) : 0);

/**
 * Per-channel outcome of one notification. Meaning never relies on color alone: every state has its own
 * text ("No entregada", "Push 0/1", "ntfy ✗"). Push is hidden when the user had no registered device.
 */
export function channelBadges(row: Pick<NotificationLogRow, 'status' | 'push_ok' | 'push_total' | 'ntfy_attempted' | 'ntfy_ok'>): ChannelBadge[] {
  const badges: ChannelBadge[] = [];
  if (row.status === 'failed') badges.push({ key: 'status', text: 'No entregada', tone: 'urgente' });

  const total = count(row.push_total);
  if (total > 0) {
    const ok = Math.min(count(row.push_ok), total);
    badges.push({
      key: 'push',
      text: `Push ${ok}/${total}`,
      srText: `Push: ${ok} de ${total} dispositivos`,
      tone: ok === total ? 'activo' : 'urgente',
    });
  }

  if (row.ntfy_attempted) {
    badges.push(
      row.ntfy_ok
        ? { key: 'ntfy', text: 'ntfy ✓', srText: 'ntfy: enviado', tone: 'activo' }
        : { key: 'ntfy', text: 'ntfy ✗', srText: 'ntfy: falló', tone: 'urgente' },
    );
  }
  return badges;
}
