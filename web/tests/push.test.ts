import { createECDH, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MAX_ENDPOINT_LENGTH,
  derivePushState,
  isAllowedPushEndpoint,
  isPlausibleEndpoint,
  isValidVapidPublicKey,
  parseEndpointBody,
  parseResubscribeBody,
  parseSubscribeBody,
  sameApplicationServerKey,
  shouldShowPushBanner,
  subscriptionKeyMismatch,
  urlBase64ToUint8Array,
  validatePushSubscription,
  type PushInputs,
} from '@/lib/push';

const ecdh = createECDH('prime256v1');
ecdh.generateKeys();
const P256DH = ecdh.getPublicKey().toString('base64url'); // 65-byte uncompressed point
const AUTH = randomBytes(16).toString('base64url');
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/dQw4w9WgXcQ:APA91bExampleToken_-xyz';
const subscription = (overrides: Record<string, unknown> = {}) => ({
  endpoint: ENDPOINT,
  expirationTime: null,
  keys: { p256dh: P256DH, auth: AUTH },
  ...overrides,
});

describe('urlBase64ToUint8Array', () => {
  it('decodes base64url with and without padding', () => {
    expect([...urlBase64ToUint8Array('AQID')]).toEqual([1, 2, 3]);
    expect([...urlBase64ToUint8Array('AQI')]).toEqual([1, 2]);
    expect([...urlBase64ToUint8Array('AQI=')]).toEqual([1, 2]);
    expect([...urlBase64ToUint8Array('')]).toEqual([]);
  });

  it('maps the url-safe alphabet (- and _)', () => {
    expect([...urlBase64ToUint8Array('-_8')]).toEqual([251, 255]);
  });

  it('round-trips a real P-256 public key to 65 bytes', () => {
    const bytes = urlBase64ToUint8Array(P256DH);
    expect(bytes.length).toBe(65);
    expect(bytes[0]).toBe(4);
    expect(Buffer.from(bytes).toString('base64url')).toBe(P256DH);
  });

  it('rejects characters outside the alphabet', () => {
    expect(() => urlBase64ToUint8Array('AQ ID')).toThrow();
    expect(() => urlBase64ToUint8Array('AQ+/')).toThrow();
    expect(() => urlBase64ToUint8Array('A')).toThrow();
  });
});

describe('isValidVapidPublicKey', () => {
  it('accepts an uncompressed P-256 point', () => {
    expect(isValidVapidPublicKey(P256DH)).toBe(true);
    expect(isValidVapidPublicKey(`  ${P256DH}\n`)).toBe(true);
  });

  it('rejects empty, short, compressed or malformed keys', () => {
    expect(isValidVapidPublicKey(undefined)).toBe(false);
    expect(isValidVapidPublicKey('')).toBe(false);
    expect(isValidVapidPublicKey('AQID')).toBe(false);
    expect(isValidVapidPublicKey(Buffer.from(ecdh.getPublicKey(undefined, 'compressed')).toString('base64url'))).toBe(false);
    expect(isValidVapidPublicKey('not base64 at all!')).toBe(false);
  });
});

describe('sameApplicationServerKey', () => {
  it('compares the bytes of a subscription key with the expected key', () => {
    const expected = urlBase64ToUint8Array(P256DH);
    expect(sameApplicationServerKey(expected.buffer, expected)).toBe(true);
    expect(sameApplicationServerKey(new Uint8Array(expected), expected)).toBe(true);
    const other = new Uint8Array(expected);
    other[10] ^= 1;
    expect(sameApplicationServerKey(other.buffer, expected)).toBe(false);
    expect(sameApplicationServerKey(new Uint8Array(3).buffer, expected)).toBe(false);
    expect(sameApplicationServerKey(null, expected)).toBe(false);
  });
});

describe('subscriptionKeyMismatch', () => {
  it('flags a subscription bound to another key, never an unknown one', () => {
    const current = urlBase64ToUint8Array(P256DH);
    const other = new Uint8Array(current);
    other[10] ^= 1;
    expect(subscriptionKeyMismatch(current.buffer, P256DH)).toBe(false);
    expect(subscriptionKeyMismatch(other.buffer, P256DH)).toBe(true);
    expect(subscriptionKeyMismatch(other.buffer, ` ${P256DH} `)).toBe(true);
    expect(subscriptionKeyMismatch(null, P256DH)).toBe(false); // browser did not report its key
    expect(subscriptionKeyMismatch(other.buffer, undefined)).toBe(false); // nothing configured to compare with
    expect(subscriptionKeyMismatch(other.buffer, 'not-a-key')).toBe(false);
  });
});

describe('endpoint rules', () => {
  it('accepts the push services of the major browsers', () => {
    for (const endpoint of [
      ENDPOINT,
      'https://updates.push.services.mozilla.com/wpush/v2/gAAAAAB',
      'https://web.push.apple.com/QGxyz',
      'https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB',
    ]) {
      expect(isAllowedPushEndpoint(endpoint)).toBe(true);
    }
  });

  it('rejects http, other hosts, look-alikes, credentials, ports and oversized values', () => {
    expect(isAllowedPushEndpoint('http://fcm.googleapis.com/fcm/send/x')).toBe(false);
    expect(isAllowedPushEndpoint('https://evil.example/fcm.googleapis.com')).toBe(false);
    expect(isAllowedPushEndpoint('https://fcm.googleapis.com.evil.example/x')).toBe(false);
    expect(isAllowedPushEndpoint('https://notfcm.googleapis.com/x')).toBe(false); // ends with the same letters, not a subdomain
    expect(isAllowedPushEndpoint('https://localhost/x')).toBe(false);
    expect(isAllowedPushEndpoint('https://127.0.0.1/x')).toBe(false);
    expect(isAllowedPushEndpoint('https://user:pw@fcm.googleapis.com/x')).toBe(false);
    expect(isAllowedPushEndpoint('https://fcm.googleapis.com:8443/x')).toBe(false);
    expect(isAllowedPushEndpoint('https://fcm.googleapis.com/x y')).toBe(false);
    expect(isAllowedPushEndpoint(`https://fcm.googleapis.com/${'a'.repeat(MAX_ENDPOINT_LENGTH)}`)).toBe(false);
    expect(isAllowedPushEndpoint('')).toBe(false);
    expect(isAllowedPushEndpoint(undefined)).toBe(false);
    expect(isAllowedPushEndpoint(42)).toBe(false);
  });

  it('plausible endpoints only need https, a sane size and no credentials', () => {
    expect(isPlausibleEndpoint('https://any.example/path')).toBe(true);
    expect(isPlausibleEndpoint('http://any.example/path')).toBe(false);
    expect(isPlausibleEndpoint('javascript:alert(1)')).toBe(false);
    expect(isPlausibleEndpoint(`https://a.example/${'a'.repeat(MAX_ENDPOINT_LENGTH)}`)).toBe(false);
  });
});

describe('validatePushSubscription', () => {
  it('accepts the JSON of PushSubscription.toJSON()', () => {
    expect(validatePushSubscription(subscription())).toEqual({
      ok: true,
      value: { endpoint: ENDPOINT, p256dh: P256DH, auth: AUTH },
    });
  });

  it('ignores extra fields and never copies a user id from the body', () => {
    const result = validatePushSubscription(subscription({ user_id: 'someone-else', extra: 1 }));
    expect(result.ok && Object.keys(result.value).sort()).toEqual(['auth', 'endpoint', 'p256dh']);
  });

  it('rejects anything that is not a complete subscription', () => {
    for (const bad of [
      null,
      'x',
      [],
      {},
      subscription({ endpoint: 'http://fcm.googleapis.com/x' }),
      subscription({ endpoint: undefined }),
      subscription({ keys: undefined }),
      subscription({ keys: { p256dh: P256DH } }),
      subscription({ keys: { auth: AUTH } }),
      subscription({ keys: { p256dh: 'short', auth: AUTH } }),
      subscription({ keys: { p256dh: P256DH, auth: 'a b' } }),
      subscription({ keys: { p256dh: 5, auth: AUTH } }),
    ]) {
      expect(validatePushSubscription(bad).ok).toBe(false);
    }
  });
});

describe('request bodies', () => {
  it('subscribe keeps a valid platform hint and drops an invalid one', () => {
    const ok = parseSubscribeBody(subscription({ platform: 'ios' }));
    expect(ok.ok && ok.value.platform).toBe('ios');
    const dropped = parseSubscribeBody(subscription({ platform: 'toaster' }));
    expect(dropped.ok && dropped.value.platform).toBeUndefined();
  });

  it('resubscribe takes an optional old endpoint plus the new subscription', () => {
    const body = { oldEndpoint: 'https://fcm.googleapis.com/fcm/send/old', subscription: subscription() };
    const parsed = parseResubscribeBody(body);
    expect(parsed.ok && parsed.value.oldEndpoint).toBe('https://fcm.googleapis.com/fcm/send/old');
    const noOld = parseResubscribeBody({ oldEndpoint: null, subscription: subscription() });
    expect(noOld.ok && noOld.value.oldEndpoint).toBeNull();
    expect(parseResubscribeBody({ subscription: subscription() }).ok).toBe(true);
    expect(parseResubscribeBody({ oldEndpoint: 'http://x', subscription: subscription() }).ok).toBe(false);
    expect(parseResubscribeBody({ oldEndpoint: null }).ok).toBe(false);
    expect(parseResubscribeBody('nope').ok).toBe(false);
  });

  it('unsubscribe and test take a plain { endpoint }', () => {
    expect(parseEndpointBody({ endpoint: ENDPOINT })).toEqual({ ok: true, value: { endpoint: ENDPOINT } });
    expect(parseEndpointBody({ endpoint: 'http://x' }).ok).toBe(false);
    expect(parseEndpointBody({}).ok).toBe(false);
    expect(parseEndpointBody(null).ok).toBe(false);
  });
});

describe('derivePushState', () => {
  const base: PushInputs = {
    vapidConfigured: true,
    supported: true,
    platform: 'android',
    standalone: false,
    permission: 'default',
    hasSubscription: false,
  };
  const state = (overrides: Partial<PushInputs>) => derivePushState({ ...base, ...overrides });

  it('needs a VAPID public key before anything else', () => {
    expect(state({ vapidConfigured: false })).toBe('unconfigured');
    expect(state({ vapidConfigured: false, platform: 'ios' })).toBe('unconfigured');
  });

  it('asks iPhone users outside the installed app to add it to the home screen', () => {
    expect(state({ platform: 'ios', supported: false, permission: null })).toBe('needs-install');
    expect(state({ platform: 'ios', supported: true, standalone: false })).toBe('needs-install');
  });

  it('reports unsupported browsers, including iOS apps too old for Web Push', () => {
    expect(state({ supported: false, permission: null })).toBe('unsupported');
    expect(state({ supported: false, permission: null, platform: 'desktop' })).toBe('unsupported');
    expect(state({ platform: 'ios', standalone: true, supported: false, permission: null })).toBe('unsupported');
  });

  it('follows the permission and subscription of a supported device', () => {
    expect(state({ permission: 'default' })).toBe('default');
    expect(state({ permission: 'denied' })).toBe('denied');
    expect(state({ permission: 'denied', hasSubscription: true })).toBe('denied');
    expect(state({ permission: 'granted', hasSubscription: true })).toBe('subscribed');
    expect(state({ permission: 'granted', hasSubscription: false })).toBe('default');
    expect(state({ platform: 'ios', standalone: true, permission: 'default' })).toBe('default');
    expect(state({ platform: 'ios', standalone: true, permission: 'granted', hasSubscription: true })).toBe('subscribed');
    expect(state({ platform: 'desktop', permission: 'granted', hasSubscription: true })).toBe('subscribed');
  });

  it('only invites the user to activate when there is something to activate', () => {
    expect(shouldShowPushBanner('default')).toBe(true);
    expect(shouldShowPushBanner('needs-install')).toBe(true);
    for (const hidden of ['subscribed', 'denied', 'unsupported', 'unconfigured'] as const) {
      expect(shouldShowPushBanner(hidden)).toBe(false);
    }
  });
});
