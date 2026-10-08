import { createECDH } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readDeviceState, resyncSubscription } from '@/lib/push-client';
import { urlBase64ToUint8Array } from '@/lib/push';

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

let posts: { url: string; body: Record<string, unknown> }[];
let current: FakeSubscription | null;
let subscribe: ReturnType<typeof vi.fn>;

function stubBrowser() {
  posts = [];
  const registration = {
    pushManager: {
      getSubscription: vi.fn(async () => current),
      subscribe,
    },
  };
  vi.stubGlobal('window', { PushManager: class {}, Notification: class {}, matchMedia: () => ({ matches: true }) });
  vi.stubGlobal('navigator', {
    userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/120',
    maxTouchPoints: 5,
    serviceWorker: { register: vi.fn(async () => registration), ready: Promise.resolve(registration) },
  });
  vi.stubGlobal('Notification', { permission: 'granted' });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { body: string }) => {
      posts.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }),
  );
}

beforeEach(() => {
  subscribe = vi.fn(async () => fakeSubscription('https://fcm.googleapis.com/fcm/send/new', CURRENT));
  stubBrowser();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resyncSubscription', () => {
  it('re-posts a subscription made with the current key', async () => {
    current = fakeSubscription('https://fcm.googleapis.com/fcm/send/same', CURRENT);
    await resyncSubscription(CURRENT);
    expect(posts.map((p) => p.url)).toEqual(['/api/push/subscribe']);
    expect(posts[0].body.endpoint).toBe('https://fcm.googleapis.com/fcm/send/same');
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
  it('does not report a subscription bound to another key as active', async () => {
    current = fakeSubscription('https://fcm.googleapis.com/fcm/send/old', OLD);
    expect((await readDeviceState(CURRENT)).state).toBe('default');
    current = fakeSubscription('https://fcm.googleapis.com/fcm/send/same', CURRENT);
    expect((await readDeviceState(CURRENT)).state).toBe('subscribed');
  });
});
