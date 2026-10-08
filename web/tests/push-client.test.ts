import { createECDH } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  enablePush,
  pushLogoutCleanup,
  readDeviceState,
  requestTestPush,
  resyncSubscription,
  waitForTestDelivery,
} from '@/lib/push-client';
import { deliveryFailing, derivePushState, parsePushServerStatus, testDelivered, urlBase64ToUint8Array } from '@/lib/push';

function newKey(): string {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return ecdh.getPublicKey().toString('base64url');
}

const CURRENT = newKey();
const OLD = newKey();

interface FakeSubscription {
  endpoint: string;
  options: { applicationServerKey: ArrayBuffer | null };
  unsubscribe: ReturnType<typeof vi.fn>;
  toJSON: () => Record<string, unknown>;
}

function fakeSubscription(endpoint: string, key: string | null): FakeSubscription {
  return {
    endpoint,
    options: { applicationServerKey: key ? (urlBase64ToUint8Array(key).buffer as ArrayBuffer) : null },
    unsubscribe: vi.fn(async () => true),
    toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh: 'p', auth: 'a' } }),
  };
}

type Reply = { status: number; body: unknown } | Error;

const REGISTERED = {
  registered: true,
  last_success_at: null,
  last_failure_at: null,
  failure_count: 0,
  last_failure_reason: null,
  test_requested_at: null,
};

let posts: { url: string; body: Record<string, unknown> }[];
let gets: string[];
let replies: Record<string, Reply>;
let current: FakeSubscription | null;
let subscribe: ReturnType<typeof vi.fn>;
let permission: NotificationPermission;
let answer: NotificationPermission;
let register: ReturnType<typeof vi.fn>;
let online: boolean;

function stubBrowser() {
  posts = [];
  gets = [];
  replies = { '/api/push/status': { status: 200, body: REGISTERED } };
  permission = 'granted';
  answer = 'granted';
  online = true;
  const registration = {
    pushManager: {
      getSubscription: vi.fn(async () => current),
      subscribe,
    },
  };
  register = vi.fn(async () => registration);
  vi.stubGlobal('window', { PushManager: class {}, Notification: class {}, matchMedia: () => ({ matches: true }) });
  vi.stubGlobal('navigator', {
    userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/120',
    maxTouchPoints: 5,
    get onLine() {
      return online;
    },
    serviceWorker: {
      register: (...args: unknown[]) => register(...args),
      ready: Promise.resolve(registration),
      getRegistration: vi.fn(async () => registration),
    },
  });
  vi.stubGlobal('Notification', {
    get permission() {
      return permission;
    },
    requestPermission: vi.fn((callback?: (value: NotificationPermission) => void) => {
      permission = answer;
      callback?.(answer);
      return Promise.resolve(answer);
    }),
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { body?: string }) => {
      if (init?.body) posts.push({ url, body: JSON.parse(init.body) });
      else gets.push(url);
      const reply = replies[url.split('?')[0]] ?? { status: 200, body: { ok: true } };
      if (reply instanceof Error) throw reply;
      return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => reply.body };
    }),
  );
}

beforeEach(() => {
  current = null;
  subscribe = vi.fn(async () => fakeSubscription('https://fcm.googleapis.com/fcm/send/new', CURRENT));
  stubBrowser();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('resyncSubscription', () => {
  it('re-posts a subscription made with the current key', async () => {
    current = fakeSubscription('https://fcm.googleapis.com/fcm/send/same', CURRENT);
    await resyncSubscription(CURRENT);
    expect(posts.map((p) => p.url)).toEqual(['/api/push/subscribe']);
    expect(posts[0].body.endpoint).toBe('https://fcm.googleapis.com/fcm/send/same');
    expect(posts[0].body).not.toHaveProperty('resetFailures');
    expect(current.unsubscribe).not.toHaveBeenCalled();
  });

  it('replaces a subscription bound to an old key instead of re-posting it', async () => {
    current = fakeSubscription('https://fcm.googleapis.com/fcm/send/old', OLD);
    await resyncSubscription(CURRENT);
    expect(current.unsubscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(1);
    const key = new Uint8Array(subscribe.mock.calls[0][0].applicationServerKey);
    expect(Buffer.from(key).toString('base64url')).toBe(CURRENT);
    expect(posts.map((p) => p.url)).toEqual(['/api/push/resubscribe']);
    expect(posts[0].body.oldEndpoint).toBe('https://fcm.googleapis.com/fcm/send/old');
    expect((posts[0].body.subscription as Record<string, unknown>).endpoint).toBe('https://fcm.googleapis.com/fcm/send/new');
  });

  it('drops the stale subscription on the server when a new one cannot be made', async () => {
    current = fakeSubscription('https://fcm.googleapis.com/fcm/send/old', OLD);
    subscribe.mockRejectedValueOnce(new Error('AbortError'));
    await resyncSubscription(CURRENT);
    expect(posts).toEqual([{ url: '/api/push/unsubscribe', body: { endpoint: 'https://fcm.googleapis.com/fcm/send/old' } }]);
  });

  it('keeps a subscription whose key the browser does not report', async () => {
    current = fakeSubscription('https://fcm.googleapis.com/fcm/send/unknown', null);
    await resyncSubscription(CURRENT);
    expect(posts.map((p) => p.url)).toEqual(['/api/push/subscribe']);
  });
});

describe('readDeviceState', () => {
  it('reports a subscription bound to another key as stale, never as active', async () => {
    current = fakeSubscription('https://fcm.googleapis.com/fcm/send/old', OLD);
    expect((await readDeviceState(CURRENT)).state).toBe('stale');
    expect(gets).toEqual([]); // no point asking the server about a dead subscription
    current = fakeSubscription('https://fcm.googleapis.com/fcm/send/same', CURRENT);
    expect((await readDeviceState(CURRENT)).state).toBe('subscribed');
  });

  it('asks the server about this endpoint and is unsynced when it has no row', async () => {
    current = fakeSubscription('https://fcm.googleapis.com/fcm/send/same', CURRENT);
    replies['/api/push/status'] = { status: 200, body: { ...REGISTERED, registered: false } };
    const snapshot = await readDeviceState(CURRENT);
    expect(snapshot.state).toBe('unsynced');
    expect(snapshot.server?.registered).toBe(false);
    expect(gets).toEqual([`/api/push/status?endpoint=${encodeURIComponent('https://fcm.googleapis.com/fcm/send/same')}`]);
  });

  it('keeps subscribed (with the server view) when the server confirms the device', async () => {
    current = fakeSubscription('https://fcm.googleapis.com/fcm/send/same', CURRENT);
    replies['/api/push/status'] = { status: 200, body: { ...REGISTERED, last_success_at: '2026-10-08T12:00:00.000Z' } };
    const snapshot = await readDeviceState(CURRENT);
    expect(snapshot.state).toBe('subscribed');
    expect(snapshot.server?.last_success_at).toBe('2026-10-08T12:00:00.000Z');
  });

  it('keeps subscribed when offline, on a network error or on a server error', async () => {
    current = fakeSubscription('https://fcm.googleapis.com/fcm/send/same', CURRENT);
    online = false;
    expect((await readDeviceState(CURRENT)).state).toBe('subscribed');
    expect(gets).toEqual([]);
    online = true;
    replies['/api/push/status'] = new TypeError('Failed to fetch');
    expect((await readDeviceState(CURRENT)).state).toBe('subscribed');
    replies['/api/push/status'] = { status: 502, body: { error: 'x' } };
    const snapshot = await readDeviceState(CURRENT);
    expect(snapshot.state).toBe('subscribed');
    expect(snapshot.server).toBeNull();
  });

  it('does not ask the server without a subscription', async () => {
    expect((await readDeviceState(CURRENT)).state).toBe('default');
    expect(gets).toEqual([]);
  });
});

describe('enablePush', () => {
  it('subscribes, stores the device and resets its failures (explicit activation)', async () => {
    permission = 'default';
    expect(await enablePush(CURRENT)).toEqual({ ok: true });
    expect(subscribe).toHaveBeenCalledOnce();
    expect(posts.map((p) => p.url)).toEqual(['/api/push/subscribe']);
    expect(posts[0].body.resetFailures).toBe(true);
    expect(posts[0].body.platform).toBe('android');
  });

  it('reports a denied or dismissed permission without subscribing', async () => {
    permission = 'default';
    answer = 'denied';
    expect(await enablePush(CURRENT)).toMatchObject({ ok: false, reason: 'denied' });
    answer = 'default';
    expect(await enablePush(CURRENT)).toMatchObject({ ok: false, reason: 'dismissed' });
    expect(subscribe).not.toHaveBeenCalled();
    expect(posts).toEqual([]);
  });

  it('reports a service worker that cannot be registered', async () => {
    register.mockResolvedValueOnce(null);
    expect(await enablePush(CURRENT)).toMatchObject({ ok: false, reason: 'no-worker' });
  });

  it('reports a subscribe that throws', async () => {
    subscribe.mockRejectedValueOnce(new Error('NotAllowedError'));
    expect(await enablePush(CURRENT)).toMatchObject({ ok: false, reason: 'subscribe-failed' });
    expect(posts).toEqual([]);
  });

  it('replaces a subscription made with a rotated key: unsubscribe, then subscribe', async () => {
    const old = fakeSubscription('https://fcm.googleapis.com/fcm/send/old', OLD);
    current = old;
    expect(await enablePush(CURRENT)).toEqual({ ok: true });
    expect(old.unsubscribe).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledOnce();
    expect(old.unsubscribe.mock.invocationCallOrder[0]).toBeLessThan(subscribe.mock.invocationCallOrder[0]);
    expect(posts[0].body.endpoint).toBe('https://fcm.googleapis.com/fcm/send/new');
  });

  it('reuses a subscription made with the current key', async () => {
    current = fakeSubscription('https://fcm.googleapis.com/fcm/send/same', CURRENT);
    expect(await enablePush(CURRENT)).toEqual({ ok: true });
    expect(subscribe).not.toHaveBeenCalled();
    expect(posts[0].body.endpoint).toBe('https://fcm.googleapis.com/fcm/send/same');
  });

  it('tells an expired session apart from a server failure', async () => {
    replies['/api/push/subscribe'] = { status: 401, body: { error: 'No autorizado.' } };
    const expired = await enablePush(CURRENT);
    expect(expired).toMatchObject({ ok: false, reason: 'server-failed' });
    expect(!expired.ok && expired.message).toContain('sesión expiró');
    replies['/api/push/subscribe'] = { status: 500, body: null };
    const failed = await enablePush(CURRENT);
    expect(failed).toMatchObject({ ok: false, reason: 'server-failed' });
    expect(!failed.ok && failed.message).toContain('no se pudo guardar');
  });
});

describe('requestTestPush', () => {
  beforeEach(() => {
    current = fakeSubscription('https://fcm.googleapis.com/fcm/send/same', CURRENT);
  });

  it('confirms the request and keeps the server request time', async () => {
    replies['/api/push/test'] = { status: 200, body: { ok: true, requestedAt: '2026-10-08T12:00:00.000Z' } };
    const result = await requestTestPush();
    expect(result).toEqual({
      ok: true,
      message: 'Llegará en menos de un minuto.',
      endpoint: 'https://fcm.googleapis.com/fcm/send/same',
      requestedAtMs: Date.parse('2026-10-08T12:00:00.000Z'),
    });
  });

  it('shows the server warning instead of promising delivery', async () => {
    replies['/api/push/test'] = { status: 200, body: { ok: true, warning: 'worker_stale' } };
    const stale = await requestTestPush();
    expect(stale.ok && stale.warning).toBe('worker_stale');
    expect(stale.message).not.toContain('menos de un minuto');
    expect(stale.message).toContain('no está respondiendo');
    replies['/api/push/test'] = { status: 200, body: { ok: true, warning: 'push_disabled' } };
    const disabled = await requestTestPush();
    expect(disabled.ok && disabled.warning).toBe('push_disabled');
    replies['/api/push/test'] = { status: 200, body: { ok: true, warning: 'something_else' } };
    const unknown = await requestTestPush();
    expect(unknown.ok && unknown.warning).toBeUndefined();
  });

  it('maps 404, 429 (with retryAfterSeconds) and 401', async () => {
    replies['/api/push/test'] = { status: 404, body: {} };
    expect(await requestTestPush()).toEqual({
      ok: false,
      message: 'Este dispositivo ya no está registrado. Desactiva y vuelve a activar.',
    });
    replies['/api/push/test'] = { status: 429, body: { retryAfterSeconds: 17 } };
    expect(await requestTestPush()).toEqual({ ok: false, message: 'Espera 17 s antes de otra prueba.' });
    replies['/api/push/test'] = { status: 429, body: {} };
    expect((await requestTestPush()).message).toBe('Espera unos segundos antes de otra prueba.');
    replies['/api/push/test'] = { status: 401, body: {} };
    expect(await requestTestPush()).toEqual({ ok: false, message: 'Tu sesión expiró. Vuelve a iniciar sesión.' });
  });

  it('refuses without a subscription', async () => {
    current = null;
    expect(await requestTestPush()).toEqual({ ok: false, message: 'Este dispositivo no tiene una suscripción activa.' });
    expect(posts).toEqual([]);
  });
});

describe('waitForTestDelivery', () => {
  const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/same';
  const REQUESTED = Date.parse('2026-10-08T12:00:00.000Z');
  const sleep = vi.fn(async (_ms: number) => undefined);

  beforeEach(() => sleep.mockClear());

  it('stops as soon as the server records a delivery after the request', async () => {
    let calls = 0;
    vi.mocked(fetch).mockImplementation(async () => {
      calls += 1;
      const last = calls < 3 ? '2026-10-08T11:00:00.000Z' : '2026-10-08T12:00:20.000Z';
      return { ok: true, status: 200, json: async () => ({ ...REGISTERED, last_success_at: last }) } as Response;
    });
    expect(await waitForTestDelivery(ENDPOINT, REQUESTED, { sleep })).toBe('delivered');
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledWith(10_000);
  });

  it('gives up after 90 s', async () => {
    expect(await waitForTestDelivery(ENDPOINT, REQUESTED, { sleep })).toBe('timeout');
    expect(sleep).toHaveBeenCalledTimes(9);
  });

  it('stops when aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await waitForTestDelivery(ENDPOINT, REQUESTED, { sleep, signal: controller.signal })).toBe('aborted');
  });
});

describe('pushLogoutCleanup', () => {
  it('removes the device on the server, then unsubscribes it locally', async () => {
    const sub = fakeSubscription('https://fcm.googleapis.com/fcm/send/same', CURRENT);
    current = sub;
    await pushLogoutCleanup();
    expect(posts).toEqual([{ url: '/api/push/unsubscribe', body: { endpoint: 'https://fcm.googleapis.com/fcm/send/same' } }]);
    expect(sub.unsubscribe).toHaveBeenCalledOnce();
    expect(vi.mocked(fetch).mock.invocationCallOrder[0]).toBeLessThan(sub.unsubscribe.mock.invocationCallOrder[0]);
  });

  it('does nothing without a subscription', async () => {
    await pushLogoutCleanup();
    expect(posts).toEqual([]);
  });

  it('still unsubscribes locally when the server call fails, and never throws', async () => {
    const sub = fakeSubscription('https://fcm.googleapis.com/fcm/send/same', CURRENT);
    current = sub;
    replies['/api/push/unsubscribe'] = new TypeError('offline');
    await expect(pushLogoutCleanup()).resolves.toBeUndefined();
    expect(sub.unsubscribe).toHaveBeenCalledOnce();
    sub.unsubscribe.mockRejectedValueOnce(new Error('boom'));
    await expect(pushLogoutCleanup()).resolves.toBeUndefined();
  });

  it('gives up after the timeout so logout is never blocked', async () => {
    vi.useFakeTimers();
    current = fakeSubscription('https://fcm.googleapis.com/fcm/send/same', CURRENT);
    vi.mocked(fetch).mockImplementation(() => new Promise<Response>(() => undefined));
    let done = false;
    const pending = pushLogoutCleanup(1500).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(1499);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(done).toBe(true);
  });
});

describe('server status helpers', () => {
  it('derives stale and unsynced only for a granted, subscribed device', () => {
    const base = {
      vapidConfigured: true,
      supported: true,
      platform: 'android' as const,
      standalone: false,
      permission: 'granted' as NotificationPermission,
      hasSubscription: true,
    };
    expect(derivePushState({ ...base, keyMismatch: true })).toBe('stale');
    expect(derivePushState({ ...base, keyMismatch: true, serverRegistered: false })).toBe('stale');
    expect(derivePushState({ ...base, serverRegistered: false })).toBe('unsynced');
    expect(derivePushState({ ...base, serverRegistered: null })).toBe('subscribed');
    expect(derivePushState({ ...base, serverRegistered: true })).toBe('subscribed');
    expect(derivePushState({ ...base, hasSubscription: false, serverRegistered: false })).toBe('default');
    expect(derivePushState({ ...base, permission: 'denied', keyMismatch: true })).toBe('denied');
  });

  it('parses the status answer tolerantly', () => {
    expect(parsePushServerStatus(null)).toBeNull();
    expect(parsePushServerStatus({ registered: 'yes' })).toBeNull();
    expect(parsePushServerStatus({ registered: true, failure_count: '3', last_success_at: 'nope', last_failure_reason: '' })).toEqual({
      registered: true,
      last_success_at: null,
      last_failure_at: null,
      failure_count: 3,
      last_failure_reason: null,
      test_requested_at: null,
    });
  });

  it('flags failing delivery only when the newest event is a failure', () => {
    const at = (h: number) => `2026-10-08T${String(h).padStart(2, '0')}:00:00.000Z`;
    expect(deliveryFailing({ failure_count: 2, last_failure_at: at(13), last_success_at: at(12) })).toBe(true);
    expect(deliveryFailing({ failure_count: 2, last_failure_at: at(11), last_success_at: at(12) })).toBe(false);
    expect(deliveryFailing({ failure_count: 1, last_failure_at: at(11), last_success_at: null })).toBe(true);
    expect(deliveryFailing({ failure_count: 0, last_failure_at: at(13), last_success_at: at(12) })).toBe(false);
    expect(testDelivered({ last_success_at: at(12) }, Date.parse(at(11)))).toBe(true);
    expect(testDelivered({ last_success_at: at(10) }, Date.parse(at(11)))).toBe(false);
    expect(testDelivered(null, Date.parse(at(11)))).toBe(false);
  });
});
