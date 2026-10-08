import 'server-only';
import { dbJson } from './db';

/**
 * Health of the VPS worker as the web sees it, from two `moodle_settings` rows written by the worker:
 * 'worker_status' (a JSON heartbeat, refreshed every tick) and 'vapid_public_key' (the key its sender signs with).
 * Both are optional: an older worker writes neither, and every reader treats that as "unknown", never as an error.
 */

/** A heartbeat older than this means the worker is stopped or stuck. */
export const WORKER_STALE_SECONDS = 180;

export interface WorkerHeartbeat {
  at: string | null;
  version: string | null;
  webpush_enabled: boolean | null;
  push_status: string | null;
  last_push_ok_at: string | null;
  /** Sender counters since the previous heartbeat (sent_ok, failed, transient, gone, ...). */
  push_counts: Record<string, number> | null;
  users_ok: number | null;
  users_err: number | null;
  last_round_mode: string | null;
  tick_seconds: number | null;
  sync_seconds: number | null;
  delivery_lag_seconds: number | null;
}

export interface WorkerStatus {
  /** Null when the worker never wrote one, or it is not readable JSON. */
  heartbeat: WorkerHeartbeat | null;
  /** The VAPID public key the worker signs with (base64url), or null when unknown. */
  vapidPublicKey: string | null;
}

export type TestPushWarning = 'worker_stale' | 'push_disabled';

const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const bool = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);

/** Epoch seconds, epoch milliseconds or an ISO string, as an ISO string. */
function instant(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  }
  const text = str(value);
  return text && !Number.isNaN(Date.parse(text)) ? text : null;
}

function counts(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'number' && Number.isFinite(entry)) out[key] = entry;
  }
  return out;
}

/** Tolerant parser of the 'worker_status' value: unknown keys are ignored, wrong types become null. */
export function parseHeartbeat(raw: string | null | undefined): WorkerHeartbeat | null {
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  return {
    at: instant(d.at),
    version: str(d.version) ?? (num(d.version) !== null ? String(d.version) : null),
    webpush_enabled: bool(d.webpush_enabled),
    push_status: str(d.push_status),
    last_push_ok_at: instant(d.last_push_ok_at),
    push_counts: counts(d.push_counts),
    users_ok: num(d.users_ok),
    users_err: num(d.users_err),
    last_round_mode: str(d.last_round_mode),
    tick_seconds: num(d.tick_seconds),
    sync_seconds: num(d.sync_seconds),
    delivery_lag_seconds: num(d.delivery_lag_seconds),
  };
}

/** True when `at` is missing, unreadable or older than `maxAgeSeconds` at `now`. */
export function isStale(at: string | null | undefined, now: Date, maxAgeSeconds = WORKER_STALE_SECONDS): boolean {
  const ms = at ? Date.parse(at) : Number.NaN;
  if (Number.isNaN(ms)) return true;
  return now.getTime() - ms > maxAgeSeconds * 1000;
}

const normalizeKey = (key: string) => key.trim().replace(/=+$/, '');

/**
 * True when both keys are known and differ: every subscription made by the web is then rejected by the
 * push services (the worker signs with another key). Unknown on either side is not a mismatch.
 */
export function vapidMismatch(workerKey: string | null | undefined, webKey: string | null | undefined): boolean {
  if (!workerKey?.trim() || !webKey?.trim()) return false;
  return normalizeKey(workerKey) !== normalizeKey(webKey);
}

/**
 * Why a test push requested now would not arrive soon: the worker is stopped (stale heartbeat), or it runs
 * with Web Push disabled. Null when it looks fine or when there is no heartbeat at all (older worker: unknown).
 */
export function testPushWarning(heartbeat: WorkerHeartbeat | null, now: Date): TestPushWarning | null {
  if (!heartbeat) return null;
  if (isStale(heartbeat.at, now)) return 'worker_stale';
  if (heartbeat.webpush_enabled === false) return 'push_disabled';
  return null;
}

export interface ServiceBadge {
  text: string;
  tone: 'activo' | 'urgente' | 'finalizado';
}

export interface ServiceSummary {
  worker: ServiceBadge;
  push: ServiceBadge;
  /** The worker signs with another VAPID key than the one the web subscribes with. */
  vapidMismatch: boolean;
  /** "sent_ok 12 · failed 1 · gone 0", or null when the worker reports no counters. */
  counts: string | null;
  roundMode: string | null;
}

const ageLabel = (iso: string, now: Date): string => {
  const seconds = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 1000));
  if (seconds < 90) return `hace ${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `hace ${minutes} min`;
  return `hace ${Math.round(minutes / 60)} h`;
};

/** What the admin "Estado del servicio" card shows. Meaning never relies on color: every state has its own text. */
export function serviceSummary(status: WorkerStatus | null, webVapidKey: string | null | undefined, now: Date): ServiceSummary {
  const hb = status?.heartbeat ?? null;
  let worker: ServiceBadge;
  if (!hb) worker = { text: 'Sin datos: el worker no reporta su estado', tone: 'finalizado' };
  else if (isStale(hb.at, now)) worker = { text: hb.at ? `Detenido (último latido ${ageLabel(hb.at, now)})` : 'Detenido', tone: 'urgente' };
  else worker = { text: `Activo (latido ${ageLabel(hb.at as string, now)})`, tone: 'activo' };

  let push: ServiceBadge;
  const detail = hb?.push_status ? ` (${hb.push_status})` : '';
  if (!hb || hb.webpush_enabled === null) push = { text: `Web Push: desconocido${detail}`, tone: 'finalizado' };
  else if (hb.webpush_enabled) push = { text: `Web Push activo${detail}`, tone: 'activo' };
  else push = { text: `Web Push desactivado${detail}`, tone: 'urgente' };

  const entries = Object.entries(hb?.push_counts ?? {});
  return {
    worker,
    push,
    vapidMismatch: vapidMismatch(status?.vapidPublicKey, webVapidKey),
    counts: entries.length > 0 ? entries.map(([key, value]) => `${key} ${value}`).join(' · ') : null,
    roundMode: hb?.last_round_mode ?? null,
  };
}

export const WORKER_STATUS_PATH = 'moodle_settings?key=in.(worker_status,vapid_public_key)&select=key,value';

/** Reads both settings rows in one request. Throws when the table cannot be read. */
export async function getWorkerStatus(): Promise<WorkerStatus> {
  const rows = await dbJson<{ key: string; value: string | null }[]>(
    WORKER_STATUS_PATH,
    {},
    'No se pudo leer el estado del servicio.',
  );
  const value = (key: string) => rows.find((row) => row.key === key)?.value ?? null;
  return { heartbeat: parseHeartbeat(value('worker_status')), vapidPublicKey: str(value('vapid_public_key')) };
}
