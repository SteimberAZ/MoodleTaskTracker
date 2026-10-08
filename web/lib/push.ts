import { isPlatform, type Platform } from './platform';

/**
 * Pure helpers for Web Push. Nothing here touches browser or server APIs at import time, so the same
 * module is used by the client components, the route handlers and the tests.
 */

export const MAX_ENDPOINT_LENGTH = 1000;

/**
 * Push services used by the browsers (Chrome, Edge, Opera, Samsung Internet: FCM; Firefox: Mozilla autopush;
 * Safari and installed iOS web apps: Apple; legacy Edge: WNS). Endpoints are fetched by the VPS worker, so an
 * arbitrary https URL supplied by a user must never be accepted (blind SSRF). The hosts are exact, except the
 * per-region WNS hosts (`<region>.notify.windows.com`); the worker (webpush_sender.py) uses the identical list.
 */
export const PUSH_EXACT_HOSTS = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'] as const;
export const PUSH_HOST_SUFFIXES = ['.notify.windows.com'] as const;

/* ------------------------------------------------------------------------- */
/* VAPID key and base64url                                                    */
/* ------------------------------------------------------------------------- */

const BASE64URL = /^[A-Za-z0-9_-]*={0,2}$/;

/** Converts a base64url string (the VAPID public key) to the bytes `PushManager.subscribe` expects. */
export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  if (!BASE64URL.test(base64String)) throw new Error('Invalid base64url string');
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

/** A VAPID public key is an uncompressed P-256 point: 65 bytes starting with 0x04. */
export function isValidVapidPublicKey(key: string | null | undefined): key is string {
  if (!key) return false;
  try {
    const bytes = urlBase64ToUint8Array(key.trim());
    return bytes.length === 65 && bytes[0] === 4;
  } catch {
    return false;
  }
}

/** True when a subscription was created with the given application server key (compared byte by byte). */
export function sameApplicationServerKey(
  existing: ArrayBuffer | ArrayBufferView | null | undefined,
  expected: Uint8Array,
): boolean {
  if (!existing) return false;
  const bytes =
    existing instanceof ArrayBuffer
      ? new Uint8Array(existing)
      : new Uint8Array(existing.buffer, existing.byteOffset, existing.byteLength);
  if (bytes.length !== expected.length) return false;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] !== expected[i]) return false;
  return true;
}

/**
 * True when a subscription is bound to a different key than the configured VAPID public key (the key
 * was rotated, or the web and the worker disagree): pushes to it are rejected, so it must be replaced.
 * Unknown on either side (no key reported by the browser, no valid key configured) is not a mismatch.
 */
export function subscriptionKeyMismatch(
  existing: ArrayBuffer | ArrayBufferView | null | undefined,
  vapidKey: string | null | undefined,
): boolean {
  if (!existing || !isValidVapidPublicKey(vapidKey)) return false;
  return !sameApplicationServerKey(existing, urlBase64ToUint8Array(vapidKey.trim()));
}

/* ------------------------------------------------------------------------- */
/* Subscription payloads                                                      */
/* ------------------------------------------------------------------------- */

const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;
const P256DH = /^[A-Za-z0-9_-]{86,90}$/;
const AUTH = /^[A-Za-z0-9_-]{16,32}$/;

/** https URL of reasonable size without credentials or whitespace (enough to build a safe filter). */
export function isPlausibleEndpoint(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== 'string' || endpoint.length === 0 || endpoint.length > MAX_ENDPOINT_LENGTH) return false;
  if (!PRINTABLE_ASCII.test(endpoint)) return false;
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port;
  } catch {
    return false;
  }
}

/** A plausible endpoint that also belongs to a known push service. Required to store a subscription. */
export function isAllowedPushEndpoint(endpoint: unknown): endpoint is string {
  if (!isPlausibleEndpoint(endpoint)) return false;
  const url = new URL(endpoint);
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return (
    (PUSH_EXACT_HOSTS as readonly string[]).includes(host) ||
    PUSH_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix) && host.length > suffix.length)
  );
}

export interface ValidSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Validates the JSON of `PushSubscription.toJSON()`: `{ endpoint, expirationTime?, keys: { p256dh, auth } }`. */
export function validatePushSubscription(input: unknown): Parsed<ValidSubscription> {
  if (!isRecord(input)) return { ok: false, error: 'Suscripción inválida.' };
  if (!isAllowedPushEndpoint(input.endpoint)) return { ok: false, error: 'Endpoint de suscripción inválido.' };
  const keys = input.keys;
  if (!isRecord(keys)) return { ok: false, error: 'Faltan las claves de la suscripción.' };
  const { p256dh, auth } = keys;
  if (typeof p256dh !== 'string' || !P256DH.test(p256dh)) return { ok: false, error: 'Clave p256dh inválida.' };
  if (typeof auth !== 'string' || !AUTH.test(auth)) return { ok: false, error: 'Clave auth inválida.' };
  return { ok: true, value: { endpoint: input.endpoint, p256dh, auth } };
}

export interface SubscribeBody extends ValidSubscription {
  /** Optional hint from the browser (the server falls back to the User-Agent). */
  platform?: Platform;
  /**
   * Sent only by an explicit "Activar" (enablePush): the device starts over with `failure_count = 0`.
   * The silent re-post on every app open never sends it, so it cannot hide a device that keeps failing.
   */
  resetFailures?: true;
}

/** Body of `POST /api/push/subscribe`: a subscription JSON plus an optional `platform` and `resetFailures: true`. */
export function parseSubscribeBody(body: unknown): Parsed<SubscribeBody> {
  const sub = validatePushSubscription(body);
  if (!sub.ok) return sub;
  const value: SubscribeBody = { ...sub.value };
  if (isRecord(body) && isPlatform(body.platform)) value.platform = body.platform;
  if (isRecord(body) && body.resetFailures === true) value.resetFailures = true;
  return { ok: true, value };
}

/** Body of `POST /api/push/resubscribe`: `{ oldEndpoint?: string | null, subscription }`. */
export function parseResubscribeBody(
  body: unknown,
): Parsed<{ oldEndpoint: string | null; subscription: SubscribeBody }> {
  if (!isRecord(body)) return { ok: false, error: 'Solicitud inválida.' };
  const old = body.oldEndpoint;
  let oldEndpoint: string | null = null;
  if (old !== undefined && old !== null) {
    if (!isPlausibleEndpoint(old)) return { ok: false, error: 'Endpoint anterior inválido.' };
    oldEndpoint = old;
  }
  const subscription = parseSubscribeBody(body.subscription);
  if (!subscription.ok) return subscription;
  return { ok: true, value: { oldEndpoint, subscription: subscription.value } };
}

/** Body of `POST /api/push/unsubscribe` and `POST /api/push/test`: `{ endpoint }`. */
export function parseEndpointBody(body: unknown): Parsed<{ endpoint: string }> {
  if (!isRecord(body) || !isPlausibleEndpoint(body.endpoint)) return { ok: false, error: 'Endpoint inválido.' };
  return { ok: true, value: { endpoint: body.endpoint } };
}

/* ------------------------------------------------------------------------- */
/* Device state machine                                                       */
/* ------------------------------------------------------------------------- */

export type PushState =
  /** No VAPID public key configured: nothing can be subscribed. */
  | 'unconfigured'
  /** The browser cannot do Web Push at all. */
  | 'unsupported'
  /** iPhone/iPad outside the installed app: Web Push only works from the home-screen icon. */
  | 'needs-install'
  /** Supported, permission not asked yet (or granted but not subscribed). */
  | 'default'
  /** The user blocked notifications; only the system settings can undo it. */
  | 'denied'
  /** Permission granted and this device has an active subscription. */
  | 'subscribed'
  /** Subscribed with another VAPID key (rotated, or the web and worker disagree): nothing can reach it. */
  | 'stale'
  /** Subscribed in the browser, but the server has no row for it: the worker would never push to it. */
  | 'unsynced';

export interface PushInputs {
  vapidConfigured: boolean;
  /** serviceWorker + PushManager + Notification all present. */
  supported: boolean;
  platform: Platform;
  /** Running as an installed app (display-mode standalone or iOS `navigator.standalone`). */
  standalone: boolean;
  /** `Notification.permission`, or null when the API does not exist. */
  permission: NotificationPermission | null;
  hasSubscription: boolean;
  /** The subscription is bound to another application server key than the configured one. */
  keyMismatch?: boolean;
  /**
   * What `GET /api/push/status` said about this subscription: false when the server has no row for it,
   * null/undefined when it could not be asked (offline, network error), which keeps the browser's view.
   */
  serverRegistered?: boolean | null;
}

export function derivePushState(input: PushInputs): PushState {
  if (!input.vapidConfigured) return 'unconfigured';
  if (input.platform === 'ios' && !input.standalone) return 'needs-install';
  if (!input.supported) return 'unsupported';
  if (input.permission === 'denied') return 'denied';
  if (input.permission === 'granted' && input.hasSubscription) {
    if (input.keyMismatch) return 'stale';
    if (input.serverRegistered === false) return 'unsynced';
    return 'subscribed';
  }
  return 'default';
}

/**
 * States where the home banner invites the user to act on this device: activate, install, repair a stale or
 * unregistered subscription, or unblock notifications in the system settings (the link goes to /notificaciones).
 */
export function shouldShowPushBanner(state: PushState): boolean {
  return (
    state === 'default' || state === 'needs-install' || state === 'stale' || state === 'unsynced' || state === 'denied'
  );
}

/* ------------------------------------------------------------------------- */
/* Server-side view of one device (GET /api/push/status)                      */
/* ------------------------------------------------------------------------- */

export interface PushServerStatus {
  /** The server has a row for this endpoint owned by the session user. */
  registered: boolean;
  last_success_at: string | null;
  last_failure_at: string | null;
  failure_count: number;
  /** Null when unknown, including before the column exists. */
  last_failure_reason: string | null;
  test_requested_at: string | null;
}

const isoOrNull = (value: unknown): string | null =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null;

/** Tolerant reader of the JSON of `GET /api/push/status`; null when it is not that shape at all. */
export function parsePushServerStatus(data: unknown): PushServerStatus | null {
  if (!isRecord(data) || typeof data.registered !== 'boolean') return null;
  const failures = Number(data.failure_count);
  return {
    registered: data.registered,
    last_success_at: isoOrNull(data.last_success_at),
    last_failure_at: isoOrNull(data.last_failure_at),
    failure_count: Number.isFinite(failures) && failures > 0 ? Math.floor(failures) : 0,
    last_failure_reason: typeof data.last_failure_reason === 'string' && data.last_failure_reason ? data.last_failure_reason : null,
    test_requested_at: isoOrNull(data.test_requested_at),
  };
}

/** The latest pushes to this device failed: there are failures and the newest one is after the last success. */
export function deliveryFailing(status: Pick<PushServerStatus, 'failure_count' | 'last_failure_at' | 'last_success_at'>): boolean {
  if (status.failure_count <= 0 || !status.last_failure_at) return false;
  if (!status.last_success_at) return true;
  return Date.parse(status.last_failure_at) > Date.parse(status.last_success_at);
}

/** A test push requested at `requestedAtMs` was delivered: the last success is newer than the request. */
export function testDelivered(status: Pick<PushServerStatus, 'last_success_at'> | null, requestedAtMs: number): boolean {
  if (!status?.last_success_at || !Number.isFinite(requestedAtMs)) return false;
  return Date.parse(status.last_success_at) >= requestedAtMs;
}
