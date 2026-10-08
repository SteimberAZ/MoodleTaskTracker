import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

/**
 * Runs public/sw.js in a bare VM context with a fake ServiceWorkerGlobalScope, so the push,
 * notification-click and subscription-change handlers are tested without a browser.
 */
const ORIGIN = 'https://tareas.example.com';
const SOURCE = readFileSync(path.resolve(__dirname, '../public/sw.js'), 'utf8');

type Handler = (event: Record<string, unknown>) => void;

function loadWorker(clients: Array<{ url: string; focus: () => Promise<unknown>; navigate?: (url: string) => Promise<unknown> }> = []) {
  const handlers: Record<string, Handler[]> = {};
  const shown: Array<{ title: string; options: Record<string, unknown> }> = [];
  const fetchMock = vi.fn(async (_url: string, _init?: unknown) => ({ ok: true }));
  const subscribe = vi.fn(async (_options: unknown) => ({
    endpoint: 'https://fcm.googleapis.com/fcm/send/new',
    toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/new', keys: { p256dh: 'P', auth: 'A' } }),
  }));
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, handler: Handler) => {
      (handlers[type] ??= []).push(handler);
    },
    skipWaiting: vi.fn(),
    clients: {
      claim: vi.fn(async () => undefined),
      matchAll: vi.fn(async () => clients),
      openWindow: vi.fn(async (_url: string) => null),
    },
    registration: {
      showNotification: vi.fn(async (title: string, options: Record<string, unknown>) => {
        shown.push({ title, options });
      }),
      pushManager: { subscribe },
    },
  };
  vm.runInNewContext(SOURCE, { self, URL, fetch: fetchMock });

  /** Dispatches an event and waits for everything passed to waitUntil. */
  async function dispatch(type: string, event: Record<string, unknown> = {}) {
    const pending: Promise<unknown>[] = [];
    const full = { ...event, waitUntil: (p: Promise<unknown>) => pending.push(p) };
    for (const handler of handlers[type] ?? []) handler(full);
    await Promise.all(pending);
  }
  return { self, shown, fetchMock, subscribe, dispatch, handlers };
}

const pushEvent = (payload: unknown) => ({
  data: {
    json: () => {
      if (typeof payload === 'string') throw new SyntaxError('not json');
      return payload;
    },
    text: () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
  },
});

describe('sw.js lifecycle', () => {
  it('activates immediately and claims open pages', async () => {
    const sw = loadWorker();
    await sw.dispatch('install');
    expect(sw.self.skipWaiting).toHaveBeenCalledOnce();
    await sw.dispatch('activate');
    expect(sw.self.clients.claim).toHaveBeenCalledOnce();
  });

  it('registers no fetch handler (nothing is cached)', () => {
    expect(loadWorker().handlers.fetch).toBeUndefined();
  });
});

describe('sw.js push', () => {
  it('shows the notification described by the payload { title, body, url, tag }', async () => {
    const sw = loadWorker();
    await sw.dispatch('push', pushEvent({ title: 'Entrega mañana', body: 'Tarea 2 vence a las 08:00', url: '/tareas/abc123', tag: 'task-abc123' }));
    expect(sw.shown).toHaveLength(1);
    expect(sw.shown[0].title).toBe('Entrega mañana');
    expect(sw.shown[0].options).toEqual({
      body: 'Tarea 2 vence a las 08:00',
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      renotify: false,
      tag: 'task-abc123',
      data: { url: `${ORIGIN}/tareas/abc123` },
    });
  });

  it('always shows something, even without data (Safari requires a visible notification)', async () => {
    const sw = loadWorker();
    await sw.dispatch('push', {});
    await sw.dispatch('push', pushEvent('Texto plano'));
    await sw.dispatch('push', pushEvent({ title: 42, body: '', url: 7 }));
    expect(sw.shown).toHaveLength(3);
    expect(sw.shown[0].title).toBe('mineral tareas');
    expect(sw.shown[0].options.body).toBe('Tienes novedades en tus tareas.');
    expect(sw.shown[1].options.body).toBe('Texto plano');
    expect(sw.shown[2].title).toBe('mineral tareas');
    expect(sw.shown[2].options.data).toEqual({ url: `${ORIGIN}/` });
    expect(sw.shown.every((n) => !('tag' in n.options))).toBe(true);
  });

  it('never links to another origin', async () => {
    const sw = loadWorker();
    await sw.dispatch('push', pushEvent({ title: 't', body: 'b', url: 'https://evil.example/phish' }));
    await sw.dispatch('push', pushEvent({ title: 't', body: 'b', url: 'javascript:alert(1)' }));
    expect(sw.shown.map((n) => (n.options.data as { url: string }).url)).toEqual([`${ORIGIN}/`, `${ORIGIN}/`]);
  });

  it('accepts an absolute same-origin url', async () => {
    const sw = loadWorker();
    await sw.dispatch('push', pushEvent({ title: 't', body: 'b', url: `${ORIGIN}/reminders/new?task=1` }));
    expect((sw.shown[0].options.data as { url: string }).url).toBe(`${ORIGIN}/reminders/new?task=1`);
  });
});

describe('sw.js links to a history entry', () => {
  const ENTRY = '/notificaciones?n=7b1f6c1e-3a52-4a52-9d0e-0c5f3a9a1b11';

  it('keeps the query string of /notificaciones?n=<uuid> intact in the notification data', async () => {
    const sw = loadWorker();
    await sw.dispatch(
      'push',
      pushEvent({ title: 'Entrega mañana', body: 'b', url: ENTRY, target: '/tareas/abc123', tag: 'task-abc123' }),
    );
    expect((sw.shown[0].options.data as { url: string }).url).toBe(`${ORIGIN}${ENTRY}`);
  });

  it('opens that exact url, query included, when the notification is tapped', async () => {
    const focus = vi.fn(async () => undefined);
    const navigate = vi.fn(async () => undefined);
    const sw = loadWorker([{ url: `${ORIGIN}/cuenta`, focus, navigate }]);
    await sw.dispatch('push', pushEvent({ title: 't', body: 'b', url: ENTRY }));
    const data = sw.shown[0].options.data as { url: string };
    await sw.dispatch('notificationclick', { notification: { close: vi.fn(), data } });
    expect(navigate).toHaveBeenCalledWith(`${ORIGIN}${ENTRY}`);

    const cold = loadWorker();
    await cold.dispatch('notificationclick', { notification: { close: vi.fn(), data } });
    expect(cold.self.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}${ENTRY}`);
  });

  it('still refuses a foreign origin even when it carries the same query', async () => {
    const sw = loadWorker();
    await sw.dispatch('push', pushEvent({ title: 't', body: 'b', url: `https://evil.example${ENTRY}` }));
    expect((sw.shown[0].options.data as { url: string }).url).toBe(`${ORIGIN}/`);
  });
});

describe('sw.js notificationclick', () => {
  const click = (url?: string) => {
    const close = vi.fn();
    return { close, event: { notification: { close, data: url === undefined ? undefined : { url } } } };
  };

  it('closes the notification and focuses + navigates an open same-origin window', async () => {
    const focus = vi.fn(async () => undefined);
    const navigate = vi.fn(async () => undefined);
    const sw = loadWorker([
      { url: 'https://other.example/', focus: vi.fn(async () => undefined) },
      { url: `${ORIGIN}/cuenta`, focus, navigate },
    ]);
    const { close, event } = click(`${ORIGIN}/tareas/abc123`);
    await sw.dispatch('notificationclick', event);
    expect(close).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith(`${ORIGIN}/tareas/abc123`);
    expect(sw.self.clients.openWindow).not.toHaveBeenCalled();
  });

  it('opens a new window when no same-origin window is open', async () => {
    const sw = loadWorker([{ url: 'https://other.example/', focus: vi.fn(async () => undefined) }]);
    const { close, event } = click(`${ORIGIN}/tareas/abc123`);
    await sw.dispatch('notificationclick', event);
    expect(close).toHaveBeenCalledOnce();
    expect(sw.self.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/tareas/abc123`);
  });

  it('falls back to opening a window when focusing fails, and to the home page without data', async () => {
    const sw = loadWorker([
      {
        url: `${ORIGIN}/`,
        focus: vi.fn(async () => {
          throw new Error('not allowed');
        }),
      },
    ]);
    await sw.dispatch('notificationclick', click().event);
    expect(sw.self.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/`);
  });
});

describe('sw.js pushsubscriptionchange', () => {
  const OLD = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/old',
    options: { applicationServerKey: new Uint8Array([4, 1, 2, 3]).buffer },
  };
  const NEW = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/new',
    toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/new', keys: { p256dh: 'P', auth: 'A' } }),
  };

  it('posts the new subscription together with the old endpoint (cookies included)', async () => {
    const sw = loadWorker();
    await sw.dispatch('pushsubscriptionchange', { oldSubscription: OLD, newSubscription: NEW });
    expect(sw.subscribe).not.toHaveBeenCalled();
    expect(sw.fetchMock).toHaveBeenCalledOnce();
    const [url, init] = sw.fetchMock.mock.calls[0] as [string, { method: string; credentials: string; headers: Record<string, string>; body: string }];
    expect(url).toBe('/api/push/resubscribe');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({
      oldEndpoint: 'https://fcm.googleapis.com/fcm/send/old',
      subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/new', keys: { p256dh: 'P', auth: 'A' } },
    });
  });

  it('resubscribes with the old application server key when no new subscription is given', async () => {
    const sw = loadWorker();
    await sw.dispatch('pushsubscriptionchange', { oldSubscription: OLD });
    expect(sw.subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: OLD.options.applicationServerKey });
    expect(sw.fetchMock).toHaveBeenCalledOnce();
  });

  it('does nothing (and does not throw) when there is nothing to resubscribe with', async () => {
    const sw = loadWorker();
    await expect(sw.dispatch('pushsubscriptionchange', {})).resolves.toBeUndefined();
    expect(sw.subscribe).not.toHaveBeenCalled();
    expect(sw.fetchMock).not.toHaveBeenCalled();
  });

  it('swallows network failures: the next app open re-posts the subscription', async () => {
    const sw = loadWorker();
    sw.fetchMock.mockRejectedValueOnce(new Error('offline'));
    await expect(sw.dispatch('pushsubscriptionchange', { oldSubscription: OLD, newSubscription: NEW })).resolves.toBeUndefined();
  });
});
