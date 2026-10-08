import { detectPlatform, type Platform } from './platform';
import {
  derivePushState,
  isValidVapidPublicKey,
  sameApplicationServerKey,
  subscriptionKeyMismatch,
  urlBase64ToUint8Array,
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

/** Reads everything the state machine needs from this device. */
export async function readDeviceState(vapidKey: string | undefined): Promise<DeviceSnapshot> {
  const platform = currentPlatform();
  const standalone = isStandalone();
  const supported = pushSupported();
  const permission = supported ? Notification.permission : null;
  let hasSubscription = false;
  if (supported && permission === 'granted') {
    const registration = await getReadyRegistration();
    const subscription = await registration?.pushManager.getSubscription().catch(() => null);
    // A subscription bound to another VAPID key never receives anything: show the device as not active.
    hasSubscription = !!subscription && !subscriptionKeyMismatch(subscription.options?.applicationServerKey, vapidKey);
  }
  const state = derivePushState({
    vapidConfigured: isValidVapidPublicKey(vapidKey),
    supported,
    platform,
    standalone,
    permission,
    hasSubscription,
  });
  return { state, platform, standalone };
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
  try {
    subscription = await registration.pushManager.getSubscription();
    // A subscription made with another key (rotated VAPID key) cannot be reused.
    if (subscription && !sameApplicationServerKey(subscription.options.applicationServerKey, key)) {
      await subscription.unsubscribe();
      subscription = null;
    }
    subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  } catch {
    return { ok: false, reason: 'subscribe-failed', message: 'No se pudo activar en este dispositivo. Inténtalo de nuevo.' };
  }

  const saved = await postJson('/api/push/subscribe', { ...subscription.toJSON(), platform: currentPlatform() });
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

/** Asks the server to queue a test push for this device (the worker sends it within about a minute). */
export async function requestTestPush(): Promise<{ ok: boolean; message: string }> {
  const registration = await getReadyRegistration();
  const subscription = await registration?.pushManager.getSubscription().catch(() => null);
  if (!subscription) return { ok: false, message: 'Este dispositivo no tiene una suscripción activa.' };

  const res = await postJson('/api/push/test', { endpoint: subscription.endpoint });
  if (res.ok) return { ok: true, message: 'Llegará en menos de un minuto.' };
  if (res.status === 429) {
    const seconds = Number(res.data?.retryAfterSeconds);
    return { ok: false, message: Number.isFinite(seconds) ? `Espera ${seconds} s antes de otra prueba.` : 'Espera unos segundos antes de otra prueba.' };
  }
  if (res.status === 404) return { ok: false, message: 'Este dispositivo ya no está registrado. Desactiva y vuelve a activar.' };
  if (res.status === 401) return { ok: false, message: 'Tu sesión expiró. Vuelve a iniciar sesión.' };
  return { ok: false, message: 'No se pudo solicitar la prueba. Inténtalo de nuevo.' };
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
