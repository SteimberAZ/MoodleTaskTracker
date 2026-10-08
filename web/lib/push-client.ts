import { detectPlatform, type Platform } from './platform';
import {
  derivePushState,
  isValidVapidPublicKey,
  parsePushServerStatus,
  sameApplicationServerKey,
  subscriptionKeyMismatch,
  testDelivered,
  testRejected,
  urlBase64ToUint8Array,
  type PushServerStatus,
  type PushState,
} from './push';

/**
 * Browser-only Web Push helpers (service worker, PushManager, install prompt). Imported by client
 * components only; every browser API is touched inside a function, never at import time.
 */

export interface DeviceSnapshot {
  state: PushState;
  platform: Platform;
  standalone: boolean;
  /** What the server said about this device's subscription; null when not asked or it could not answer. */
  server: PushServerStatus | null;
}

export function pushSupported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return window.matchMedia?.('(display-mode: standalone)').matches === true || nav.standalone === true;
}

export function currentPlatform(): Platform {
  return detectPlatform(navigator.userAgent, navigator.maxTouchPoints);
}

/** Registers `/sw.js` (idempotent). Scope `/`, and the script is never served from the HTTP cache. */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
  } catch {
    return null;
  }
}

/** Active registration, or null when the worker cannot be registered or does not activate in time. */
export async function getReadyRegistration(timeoutMs = 8000): Promise<ServiceWorkerRegistration | null> {
  if (!(await registerServiceWorker())) return null;
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
}

const STATUS_TIMEOUT_MS = 8000;

/**
 * Asks the server what it knows about this device (`POST /api/push/status`). Null when it cannot answer:
 * offline, network error, timeout, logged out or any non-2xx. Callers then keep the browser's own view.
 */
export async function fetchPushStatus(endpoint: string): Promise<PushServerStatus | null> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return null;
  try {
    // POST, so the endpoint (a capability URL) never appears in a query string or an access log.
    const res = await fetch('/api/push/status', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint }),
      signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(STATUS_TIMEOUT_MS) : undefined,
    });
    if (!res.ok) return null;
    return parsePushServerStatus(await res.json());
  } catch {
    return null;
  }
}

/**
 * Reads everything the state machine needs from this device. A subscription bound to another VAPID key is
 * 'stale'; otherwise the server is asked whether it has the subscription ('unsynced' when it does not).
 * When the server cannot be asked (offline, network error) the browser's subscription keeps 'subscribed'.
 */
export async function readDeviceState(vapidKey: string | undefined): Promise<DeviceSnapshot> {
  const platform = currentPlatform();
  const standalone = isStandalone();
  const supported = pushSupported();
  const permission = supported ? Notification.permission : null;
  let hasSubscription = false;
  let keyMismatch = false;
  let server: PushServerStatus | null = null;
  if (supported && permission === 'granted') {
    const registration = await getReadyRegistration();
    const subscription = await registration?.pushManager.getSubscription().catch(() => null);
    if (subscription) {
      hasSubscription = true;
      // A subscription bound to another VAPID key never receives anything.
      keyMismatch = subscriptionKeyMismatch(subscription.options?.applicationServerKey, vapidKey);
      if (!keyMismatch) server = await fetchPushStatus(subscription.endpoint);
    }
  }
  const state = derivePushState({
    vapidConfigured: isValidVapidPublicKey(vapidKey),
    supported,
    platform,
    standalone,
    permission,
    hasSubscription,
    keyMismatch,
    serverRegistered: server ? server.registered : null,
  });
  return { state, platform, standalone, server };
}

interface PostResult {
  ok: boolean;
  status: number;
  data: Record<string, unknown> | null;
}

async function postJson(url: string, body: unknown): Promise<PostResult> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

export type EnableResult =
  | { ok: true }
  | { ok: false; reason: 'denied' | 'dismissed' | 'no-worker' | 'subscribe-failed' | 'server-failed'; message: string };

/**
 * Asks for permission, subscribes this device and stores the subscription.
 * `Notification.requestPermission()` is called synchronously, before anything is awaited: iOS only
 * shows the prompt while the click's user gesture is still alive.
 */
export async function enablePush(vapidKey: string): Promise<EnableResult> {
  const permission = await requestPermission();
  if (permission === 'denied') {
    return { ok: false, reason: 'denied', message: 'Bloqueaste las notificaciones. Actívalas desde los ajustes del dispositivo.' };
  }
  if (permission !== 'granted') {
    return { ok: false, reason: 'dismissed', message: 'No diste permiso. Puedes intentarlo de nuevo cuando quieras.' };
  }

  const registration = await getReadyRegistration();
  if (!registration) {
    return { ok: false, reason: 'no-worker', message: 'No se pudo preparar este dispositivo. Recarga la página e inténtalo de nuevo.' };
  }

  const key = urlBase64ToUint8Array(vapidKey.trim());
  let subscription: PushSubscription | null = null;
  let staleEndpoint: string | null = null;
  try {
    subscription = await registration.pushManager.getSubscription();
    // A subscription made with another key (rotated VAPID key) cannot be reused.
    if (subscription && !sameApplicationServerKey(subscription.options.applicationServerKey, key)) {
      staleEndpoint = subscription.endpoint;
      await subscription.unsubscribe();
      subscription = null;
    }
    subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  } catch {
    return { ok: false, reason: 'subscribe-failed', message: 'No se pudo activar en este dispositivo. Inténtalo de nuevo.' };
  }

  // resetFailures: an explicit activation starts the device over (the silent resync never sends it).
  const saved = await postJson('/api/push/subscribe', {
    ...subscription.toJSON(),
    platform: currentPlatform(),
    resetFailures: true,
  });
  if (!saved.ok) {
    return {
      ok: false,
      reason: 'server-failed',
      message:
        saved.status === 401
          ? 'Tu sesión expiró. Vuelve a iniciar sesión.'
          : 'El dispositivo se activó pero no se pudo guardar. Inténtalo de nuevo.',
    };
  }
  // The replaced subscription can never receive anything: drop its server row (best effort) so the worker
  // stops pushing to it and it does not show as a failing device.
  if (staleEndpoint && staleEndpoint !== subscription.endpoint) {
    await postJson('/api/push/unsubscribe', { endpoint: staleEndpoint });
  }
  return { ok: true };
}

function requestPermission(): Promise<NotificationPermission> {
  // Older Safari only supports the callback form; the promise form is used when it exists.
  return new Promise((resolve) => {
    const result = Notification.requestPermission((value) => resolve(value)) as Promise<NotificationPermission> | undefined;
    if (result && typeof result.then === 'function') result.then(resolve, () => resolve(Notification.permission));
  });
}

/** Unsubscribes this device locally and removes it on the server. */
export async function disablePush(): Promise<{ ok: boolean }> {
  const registration = await getReadyRegistration();
  const subscription = await registration?.pushManager.getSubscription().catch(() => null);
  if (!subscription) return { ok: true };
  const endpoint = subscription.endpoint;
  const unsubscribed = await subscription.unsubscribe().catch(() => false);
  const removed = await postJson('/api/push/unsubscribe', { endpoint });
  return { ok: unsubscribed && removed.ok };
}

export type TestPushWarning = 'worker_stale' | 'push_disabled';

export type TestPushResult =
  | { ok: true; message: string; endpoint: string; requestedAtMs: number; warning?: TestPushWarning }
  | { ok: false; message: string };

const TEST_WARNINGS: Record<TestPushWarning, string> = {
  worker_stale: 'El servicio de avisos no está respondiendo ahora. La prueba llegará cuando vuelva a funcionar.',
  push_disabled: 'Las notificaciones push están desactivadas en el servidor. La prueba no llegará por ahora.',
};

/**
 * Asks the server to queue a test push for this device (the worker sends it within about a minute).
 * When the server warns that the worker is stopped or has Web Push disabled, that warning is the message.
 */
export async function requestTestPush(): Promise<TestPushResult> {
  const registration = await getReadyRegistration();
  const subscription = await registration?.pushManager.getSubscription().catch(() => null);
  if (!subscription) return { ok: false, message: 'Este dispositivo no tiene una suscripción activa.' };

  const sentAt = Date.now();
  const res = await postJson('/api/push/test', { endpoint: subscription.endpoint });
  if (res.ok) {
    const serverAt = typeof res.data?.requestedAt === 'string' ? Date.parse(res.data.requestedAt) : Number.NaN;
    const requestedAtMs = Number.isNaN(serverAt) ? sentAt : serverAt;
    const raw = res.data?.warning;
    const warning = raw === 'worker_stale' || raw === 'push_disabled' ? raw : undefined;
    return {
      ok: true,
      endpoint: subscription.endpoint,
      requestedAtMs,
      message: warning ? TEST_WARNINGS[warning] : 'Llegará en menos de un minuto.',
      ...(warning ? { warning } : {}),
    };
  }
  if (res.status === 429) {
    const seconds = Number(res.data?.retryAfterSeconds);
    return { ok: false, message: Number.isFinite(seconds) ? `Espera ${seconds} s antes de otra prueba.` : 'Espera unos segundos antes de otra prueba.' };
  }
  if (res.status === 404) return { ok: false, message: 'Este dispositivo ya no está registrado. Desactiva y vuelve a activar.' };
  if (res.status === 401) return { ok: false, message: 'Tu sesión expiró. Vuelve a iniciar sesión.' };
  return { ok: false, message: 'No se pudo solicitar la prueba. Inténtalo de nuevo.' };
}

export interface WaitOptions {
  intervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * After a test request: asks `/api/push/status` every 10 s, for up to 90 s, whether the device got a push
 * after `requestedAtMs`. 'rejected' when the newest event recorded after the request is a failure (the
 * worker answered but the push service refused the push). 'aborted' when the signal fires (the card
 * unmounted or another action started).
 */
export async function waitForTestDelivery(
  endpoint: string,
  requestedAtMs: number,
  { intervalMs = 10_000, timeoutMs = 90_000, signal, sleep = defaultSleep }: WaitOptions = {},
): Promise<'delivered' | 'rejected' | 'timeout' | 'aborted'> {
  for (let waited = 0; waited < timeoutMs; ) {
    const step = Math.min(intervalMs, timeoutMs - waited);
    await sleep(step);
    waited += step;
    if (signal?.aborted) return 'aborted';
    const status = await fetchPushStatus(endpoint);
    if (testDelivered(status, requestedAtMs)) return 'delivered';
    if (testRejected(status, requestedAtMs)) return 'rejected';
    if (signal?.aborted) return 'aborted';
  }
  return 'timeout';
}

/**
 * Path plus query of an `open-url` message from the service worker, only when it is a same-origin URL
 * (relative or absolute); anything else is refused (null) so the page never routes somewhere foreign.
 */
export function openUrlTarget(raw: unknown, origin: string): string | null {
  if (typeof raw !== 'string' || !raw || raw.length > 2000) return null;
  try {
    const url = new URL(raw, origin);
    if (url.origin !== origin || (url.protocol !== 'https:' && url.protocol !== 'http:')) return null;
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

/**
 * Logout cleanup, run before the logout form posts: while the session cookie is still valid, removes this
 * device on the server, then unsubscribes it locally, so nobody's pushes keep arriving on a shared device.
 * Bounded by `timeoutMs` and never throws: logging out must never be blocked by it.
 */
export async function pushLogoutCleanup(timeoutMs = 1500): Promise<void> {
  const work = (async () => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const container = navigator.serviceWorker;
    const registration =
      typeof container.getRegistration === 'function' ? await container.getRegistration() : await container.ready;
    const subscription = await registration?.pushManager.getSubscription();
    if (!subscription) return;
    await postJson('/api/push/unsubscribe', { endpoint: subscription.endpoint });
    await subscription.unsubscribe();
  })().catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * On every app open: if this device is subscribed, silently re-post it so the database stays fresh.
 * A subscription bound to another VAPID key (rotated or mismatched key) is replaced by one made with
 * `vapidKey` (permission is already granted); if that fails it is dropped, so the device shows as not
 * active and the user can enable it again.
 */
export async function resyncSubscription(vapidKey?: string): Promise<void> {
  if (!pushSupported() || Notification.permission !== 'granted') return;
  const registration = await getReadyRegistration();
  const subscription = await registration?.pushManager.getSubscription().catch(() => null);
  if (!registration || !subscription) return;
  // Errors (logged out, offline) are ignored on purpose: the next app open tries again.
  if (!subscriptionKeyMismatch(subscription.options?.applicationServerKey, vapidKey)) {
    await postJson('/api/push/subscribe', { ...subscription.toJSON(), platform: currentPlatform() });
    return;
  }
  const oldEndpoint = subscription.endpoint;
  await subscription.unsubscribe().catch(() => false);
  let fresh: PushSubscription | null = null;
  try {
    fresh = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array((vapidKey ?? '').trim()),
    });
  } catch {
    fresh = null;
  }
  if (fresh) {
    await postJson('/api/push/resubscribe', { oldEndpoint, subscription: { ...fresh.toJSON(), platform: currentPlatform() } });
  } else {
    await postJson('/api/push/unsubscribe', { endpoint: oldEndpoint });
  }
}

/* ------------------------------------------------------------------------- */
/* "Instalar app" (Chrome / Edge `beforeinstallprompt`)                       */
/* ------------------------------------------------------------------------- */

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

// The event fires once per page load, usually before the user opens /notificaciones, so it is kept here.
let deferredPrompt: BeforeInstallPromptEvent | null = null;
const promptListeners = new Set<() => void>();

export function captureInstallPrompt(event: Event): void {
  deferredPrompt = event as BeforeInstallPromptEvent;
  promptListeners.forEach((listener) => listener());
}

export function clearInstallPrompt(): void {
  deferredPrompt = null;
  promptListeners.forEach((listener) => listener());
}

export function hasInstallPrompt(): boolean {
  return deferredPrompt !== null;
}

export function onInstallPromptChange(listener: () => void): () => void {
  promptListeners.add(listener);
  return () => {
    promptListeners.delete(listener);
  };
}

export async function runInstallPrompt(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const prompt = deferredPrompt;
  if (!prompt) return 'unavailable';
  await prompt.prompt();
  const { outcome } = await prompt.userChoice;
  clearInstallPrompt();
  return outcome;
}
