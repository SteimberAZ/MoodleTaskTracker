import { GUAYAQUIL_OFFSET_MINUTES } from './time';

/** Pure grouping of the "Pendientes" page by Guayaquil calendar day (fixed UTC-5, no DST). */
export type TaskGroupKey = 'hoy' | 'manana' | 'semana' | 'despues';

export const TASK_GROUP_LABELS: Record<TaskGroupKey, string> = {
  hoy: 'Hoy',
  manana: 'Mañana',
  semana: 'Esta semana',
  despues: 'Más adelante',
};

const ORDER: TaskGroupKey[] = ['hoy', 'manana', 'semana', 'despues'];
const DAY_SECONDS = 24 * 60 * 60;
const OFFSET_SECONDS = GUAYAQUIL_OFFSET_MINUTES * 60;

/** Days since the epoch on the Guayaquil calendar. */
export function guayaquilDay(unixSeconds: number): number {
  return Math.floor((unixSeconds + OFFSET_SECONDS) / DAY_SECONDS);
}

/** 0 = Monday ... 6 = Sunday, on the Guayaquil calendar (the epoch day was a Thursday). */
function weekdayMondayFirst(day: number): number {
  return (((day + 3) % 7) + 7) % 7;
}

/**
 * Which heading a deadline belongs to. "Esta semana" runs until Sunday of the current week (weeks start on
 * Monday); deadlines already past (a task due earlier today) still count as "Hoy".
 */
export function taskGroupKey(dueTimestamp: number, nowSeconds: number): TaskGroupKey {
  const today = guayaquilDay(nowSeconds);
  const due = guayaquilDay(dueTimestamp);
  if (due <= today) return 'hoy';
  if (due === today + 1) return 'manana';
  const sunday = today + (6 - weekdayMondayFirst(today));
  return due <= sunday ? 'semana' : 'despues';
}

export interface TaskGroup<T> {
  key: TaskGroupKey;
  label: string;
  items: T[];
}

/** Groups items in their given order; empty groups are left out. */
export function groupTasksByDay<T extends { due_timestamp: number }>(items: T[], nowSeconds: number): TaskGroup<T>[] {
  const buckets = new Map<TaskGroupKey, T[]>();
  for (const item of items) {
    const key = taskGroupKey(item.due_timestamp, nowSeconds);
    buckets.set(key, [...(buckets.get(key) ?? []), item]);
  }
  return ORDER.filter((key) => buckets.has(key)).map((key) => ({
    key,
    label: TASK_GROUP_LABELS[key],
    items: buckets.get(key)!,
  }));
}

/** A brand-new account (or a fresh login) whose first sync may still be running. */
export const FIRST_SYNC_WINDOW_MS = 3 * 60 * 1000;
/**
 * How long after a login a missing or older `last_synced_at` still means "the sync is on its way". Past this
 * the worker is late or failing, and the page must not keep promising tasks (the error banner covers it).
 */
export const LOGIN_SYNC_WINDOW_MS = 10 * 60 * 1000;

export interface SyncSignals {
  createdAt: string | null;
  lastLoginAt: string | null;
  /** Undefined when the column is not available yet. */
  lastSyncedAt?: string | null;
  /** Rows of the user in any state; null when the count could not be read. */
  totalTasks: number | null;
}

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

/**
 * True while the worker has probably not finished the first sync after the last login, so the empty list
 * must say "Estamos trayendo tus tareas" instead of "No tienes tareas pendientes".
 */
export function isAwaitingFirstSync(signals: SyncSignals, nowMs: number): boolean {
  const created = ms(signals.createdAt);
  const login = ms(signals.lastLoginAt);
  const recent = (t: number | null, window: number) => t !== null && nowMs - t >= -60_000 && nowMs - t < window;

  if (signals.totalTasks === 0 && (recent(created, FIRST_SYNC_WINDOW_MS) || recent(login, FIRST_SYNC_WINDOW_MS))) {
    return true;
  }
  if (signals.lastSyncedAt === undefined || !recent(login, LOGIN_SYNC_WINDOW_MS)) return false;
  const synced = ms(signals.lastSyncedAt);
  return synced === null || (login !== null && synced < login);
}
