/* mineral tareas service worker: Web Push only.
 * Plain JS on purpose (no build step). It does not cache anything: authenticated pages must never be stored. */
'use strict';

const FALLBACK_TITLE = 'mineral tareas';
const FALLBACK_BODY = 'Tienes novedades en tus tareas.';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

/** Same-origin absolute URL for a payload `url` (relative or absolute); anything else falls back to the home page. */
function resolveUrl(raw) {
  try {
    const url = new URL(typeof raw === 'string' && raw ? raw : '/', self.location.origin);
    return url.origin === self.location.origin ? url.href : new URL('/', self.location.origin).href;
  } catch (_) {
    return new URL('/', self.location.origin).href;
  }
}

/** Payload JSON is { title, body, url, tag }. Safari requires every push to show a notification, so fall back to text. */
function readPayload(event) {
  if (!event.data) return {};
  try {
    const data = event.data.json();
    return data && typeof data === 'object' ? data : { body: String(data) };
  } catch (_) {
    try {
      return { body: event.data.text() };
    } catch (_) {
      return {};
    }
  }
}

self.addEventListener('push', (event) => {
  const data = readPayload(event);
  const title = typeof data.title === 'string' && data.title ? data.title : FALLBACK_TITLE;
  const body = typeof data.body === 'string' && data.body ? data.body : FALLBACK_BODY;
  const options = {
    body,
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    data: { url: resolveUrl(data.url) },
  };
  if (typeof data.tag === 'string' && data.tag) {
    options.tag = data.tag;
    // A newer message with the same tag (e.g. "Falta 1 dia" -> "Faltan menos de 8 horas") replaces the
    // old one and must alert again; renotify is only valid together with a tag.
    options.renotify = true;
  }
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = resolveUrl(event.notification.data && event.notification.data.url);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        try {
          await client.focus();
          if ('navigate' in client) await client.navigate(target);
          return;
        } catch (_) {
          // Fall through to opening a new window.
        }
      }
      if (self.clients.openWindow) await self.clients.openWindow(target);
    })(),
  );
});

/** The push service rotated the subscription: subscribe again with the same key and tell the server. */
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const oldSubscription = event.oldSubscription || null;
      let subscription = event.newSubscription || null;
      if (!subscription) {
        const key = oldSubscription && oldSubscription.options && oldSubscription.options.applicationServerKey;
        if (!key) return; // The page re-posts the current subscription on the next app open.
        subscription = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      }
      await fetch('/api/push/resubscribe', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          oldEndpoint: oldSubscription ? oldSubscription.endpoint : null,
          subscription: subscription.toJSON(),
        }),
      });
    })().catch(() => {
      // Best effort: the next app open re-posts the subscription.
    }),
  );
});
