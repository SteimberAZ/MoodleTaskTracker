import { describe, expect, it } from 'vitest';
import {
  PUSH_OWNERS_PATH,
  countByOwner,
  formatDeviceCount,
  pushDeletePath,
  pushEndpointQuery,
  pushTestRequest,
  pushUpsertRequest,
} from '@/lib/push-query';
import { isSameOriginRequest } from '@/lib/request-guard';

const USER = '3f2c8a52-8d5e-4a0b-9f0e-6f3a1c2b4d5e';
const OTHER = '11111111-2222-3333-4444-555555555555';
const NOW = '2026-10-08T12:00:00.000Z';
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc:APA91b_-xyz';
const SUB = { endpoint: ENDPOINT, p256dh: 'P'.repeat(87), auth: 'A'.repeat(22) };
const META = { userAgent: 'UA/1.0', platform: 'android' as const, nowIso: NOW };

describe('push subscription upsert', () => {
  it('upserts by endpoint and writes the session user as owner', () => {
    const req = pushUpsertRequest(USER, SUB, META);
    expect(req.path).toBe('moodle_push_subscriptions?on_conflict=endpoint');
    expect(req.headers.Prefer).toBe('resolution=merge-duplicates,return=minimal');
    expect(req.body).toEqual({
      user_id: USER,
      endpoint: ENDPOINT,
      p256dh: SUB.p256dh,
      auth: SUB.auth,
      user_agent: 'UA/1.0',
      platform: 'android',
      updated_at: NOW,
    });
  });

  it('does not touch the worker-owned columns', () => {
    const body = pushUpsertRequest(USER, SUB, META).body;
    for (const column of ['failure_count', 'last_success_at', 'last_failure_at', 'test_requested_at', 'id', 'created_at']) {
      expect(body).not.toHaveProperty(column);
    }
  });

  it('refuses a user id that is not a UUID', () => {
    expect(() => pushUpsertRequest('x&user_id=neq.1', SUB, META)).toThrow();
    expect(() => pushUpsertRequest('', SUB, META)).toThrow();
  });
});

describe('push subscription scoping', () => {
  it('addresses one device by endpoint AND owner', () => {
    expect(pushEndpointQuery(USER, ENDPOINT)).toBe(`?user_id=eq.${USER}&endpoint=eq.${encodeURIComponent(ENDPOINT)}`);
    expect(pushDeletePath(USER, ENDPOINT)).toBe(
      `moodle_push_subscriptions?user_id=eq.${USER}&endpoint=eq.${encodeURIComponent(ENDPOINT)}`,
    );
    expect(pushDeletePath(OTHER, ENDPOINT)).toContain(`user_id=eq.${OTHER}`);
  });

  it('the owner filter always comes first and is never omitted', () => {
    expect(pushDeletePath(USER, ENDPOINT).startsWith(`moodle_push_subscriptions?user_id=eq.${USER}&`)).toBe(true);
    expect(pushTestRequest(USER, ENDPOINT, NOW).path.startsWith(`moodle_push_subscriptions?user_id=eq.${USER}&`)).toBe(true);
  });

  it('queues a test by setting test_requested_at on that device only', () => {
    const req = pushTestRequest(USER, ENDPOINT, NOW);
    expect(req.path).toBe(
      `moodle_push_subscriptions?user_id=eq.${USER}&endpoint=eq.${encodeURIComponent(ENDPOINT)}&select=id`,
    );
    expect(req.body).toEqual({ test_requested_at: NOW });
  });

  it('refuses endpoints and users that could inject extra filters', () => {
    expect(() => pushEndpointQuery(USER, 'http://insecure.example/x')).toThrow();
    expect(() => pushEndpointQuery(USER, 'not a url')).toThrow();
    expect(() => pushEndpointQuery(USER, `https://fcm.googleapis.com/x y`)).toThrow();
    expect(() => pushEndpointQuery('x&user_id=neq.1', ENDPOINT)).toThrow();
    // Anything unusual inside an accepted endpoint is percent-encoded, so it cannot add a filter.
    expect(pushEndpointQuery(USER, 'https://fcm.googleapis.com/x&user_id=neq.1')).toContain('x%26user_id%3Dneq.1');
  });
});

describe('admin device counts', () => {
  it('counts subscriptions per owner', () => {
    const counts = countByOwner([{ user_id: USER }, { user_id: OTHER }, { user_id: USER }]);
    expect(counts.get(USER)).toBe(2);
    expect(counts.get(OTHER)).toBe(1);
    expect(counts.get('nobody')).toBeUndefined();
    expect(PUSH_OWNERS_PATH).toContain('select=user_id');
  });

  it('formats the count in Spanish and shows a dash when unknown', () => {
    expect(formatDeviceCount(0)).toBe('0 dispositivos');
    expect(formatDeviceCount(1)).toBe('1 dispositivo');
    expect(formatDeviceCount(3)).toBe('3 dispositivos');
    expect(formatDeviceCount(undefined)).toBe('—');
  });
});

describe('isSameOriginRequest', () => {
  const host = 'tareas.example.com';

  it('accepts same-origin browser requests', () => {
    expect(isSameOriginRequest({ origin: `https://${host}`, secFetchSite: 'same-origin', host })).toBe(true);
    expect(isSameOriginRequest({ origin: `https://${host}`, host })).toBe(true);
    expect(isSameOriginRequest({ origin: `https://${host}`, host: 'internal:3000', forwardedHost: host })).toBe(true);
  });

  it('accepts requests without an Origin header (non-browser clients rely on the cookie)', () => {
    expect(isSameOriginRequest({ host })).toBe(true);
    expect(isSameOriginRequest({ origin: null, secFetchSite: null, host })).toBe(true);
  });

  it('rejects cross-site and mismatched origins', () => {
    expect(isSameOriginRequest({ origin: 'https://evil.example', host })).toBe(false);
    expect(isSameOriginRequest({ origin: `https://${host}.evil.example`, host })).toBe(false);
    expect(isSameOriginRequest({ origin: `https://${host}`, secFetchSite: 'cross-site', host })).toBe(false);
    expect(isSameOriginRequest({ origin: `https://${host}`, secFetchSite: 'same-site', host })).toBe(false);
    expect(isSameOriginRequest({ origin: 'null', host })).toBe(false);
    expect(isSameOriginRequest({ origin: 'not a url', host })).toBe(false);
  });
});
