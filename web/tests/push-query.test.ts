import { describe, expect, it } from 'vitest';
import {
  MAX_DEVICES_PER_USER,
  PUSH_OWNERS_PATH,
  countByOwner,
  deviceFailing,
  devicePlatformLabel,
  formatDeviceCount,
  groupByOwner,
  isMissingColumnError,
  pushDeleteIdsPath,
  pushDeletePath,
  pushEndpointQuery,
  pushHealthPath,
  pushOverflowPath,
  pushStatusFromRows,
  pushStatusPath,
  pushTestRequest,
  pushUpsertRequest,
  pushUserDevicesPath,
} from '@/lib/push-query';
import { PUSH_EXACT_HOSTS, PUSH_HOST_SUFFIXES, isAllowedPushEndpoint, parseSubscribeBody } from '@/lib/push';
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

describe('push endpoint allowlist (exact hosts, identical to the worker)', () => {
  it('accepts only the exact push service hosts plus regional WNS hosts', () => {
    for (const ok of [
      'https://fcm.googleapis.com/fcm/send/x',
      'https://updates.push.services.mozilla.com/wpush/v2/x',
      'https://web.push.apple.com/x',
      'https://wns2-par02p.notify.windows.com/w/?token=x',
    ]) {
      expect(isAllowedPushEndpoint(ok)).toBe(true);
    }
  });

  it('rejects other subdomains of the push services and plain http', () => {
    for (const bad of [
      'https://random.push.apple.com/x',
      'https://api.push.apple.com/x',
      'https://evil.fcm.googleapis.com/x',
      'https://push.services.mozilla.com/x',
      'https://other.push.services.mozilla.com/x',
      'https://notify.windows.com/x',
      'https://evil.notify.windows.com.example/x',
      'http://fcm.googleapis.com/fcm/send/x',
    ]) {
      expect(isAllowedPushEndpoint(bad)).toBe(false);
    }
    expect(PUSH_EXACT_HOSTS).toEqual(['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com']);
    expect(PUSH_HOST_SUFFIXES).toEqual(['.notify.windows.com']);
  });
});

describe('device cap', () => {
  it('lists the ids beyond the newest ten devices of the user', () => {
    expect(MAX_DEVICES_PER_USER).toBe(10);
    expect(pushOverflowPath(USER)).toBe(
      `moodle_push_subscriptions?user_id=eq.${USER}&select=id&order=updated_at.desc,id.desc&offset=10&limit=1000`,
    );
  });

  it('deletes only uuid ids, always scoped to the owner', () => {
    const a = '7b1f6c1e-3a52-4a52-9d0e-0c5f3a9a1b11';
    const b = '8c2f6c1e-3a52-4a52-9d0e-0c5f3a9a1b22';
    expect(pushDeleteIdsPath(USER, [a, b, a, '1);drop'])).toBe(`moodle_push_subscriptions?user_id=eq.${USER}&id=in.(${a},${b})`);
    expect(pushDeleteIdsPath(USER, [])).toBeNull();
    expect(pushDeleteIdsPath(USER, ['not-a-uuid'])).toBeNull();
    expect(() => pushDeleteIdsPath('x', [a])).toThrow();
  });

  it('counts the devices of one user by id only', () => {
    expect(pushUserDevicesPath(USER)).toBe(`moodle_push_subscriptions?user_id=eq.${USER}&select=id&limit=11`);
  });
});

describe('resetFailures', () => {
  it('resets failure_count only when the explicit activation asks for it', () => {
    expect(pushUpsertRequest(USER, SUB, META).body).not.toHaveProperty('failure_count');
    expect(pushUpsertRequest(USER, SUB, META, { resetFailures: false }).body).not.toHaveProperty('failure_count');
    expect(pushUpsertRequest(USER, SUB, META, { resetFailures: true }).body.failure_count).toBe(0);
    expect(pushUpsertRequest(USER, SUB, META, { resetFailures: true }).body).toHaveProperty('last_failure_at', null);
    expect(pushUpsertRequest(USER, SUB, META).body).not.toHaveProperty('last_failure_at');
  });

  it('is parsed from the subscribe body only when it is exactly true', () => {
    const json = { endpoint: ENDPOINT, keys: { p256dh: SUB.p256dh, auth: SUB.auth } };
    const on = parseSubscribeBody({ ...json, resetFailures: true });
    expect(on.ok && on.value.resetFailures).toBe(true);
    for (const value of [undefined, false, 'true', 1]) {
      const off = parseSubscribeBody({ ...json, resetFailures: value });
      expect(off.ok && off.value.resetFailures).toBeUndefined();
    }
  });
});

describe('device status and health reads', () => {
  it('reads one device of the session user, with a fallback without last_failure_reason', () => {
    const q = encodeURIComponent(ENDPOINT);
    expect(pushStatusPath(USER, ENDPOINT)).toBe(
      `moodle_push_subscriptions?user_id=eq.${USER}&endpoint=eq.${q}` +
        '&select=last_success_at,last_failure_at,failure_count,test_requested_at,last_failure_reason&limit=1',
    );
    expect(pushStatusPath(USER, ENDPOINT, false)).not.toContain('last_failure_reason');
    expect(() => pushStatusPath(OTHER.slice(1), ENDPOINT)).toThrow();
  });

  it('maps rows to the /api/push/status answer', () => {
    expect(pushStatusFromRows([])).toEqual({
      registered: false,
      last_success_at: null,
      last_failure_at: null,
      failure_count: 0,
      last_failure_reason: null,
      test_requested_at: null,
    });
    expect(
      pushStatusFromRows([{ last_success_at: NOW, last_failure_at: null, failure_count: 2, test_requested_at: null }]),
    ).toEqual({
      registered: true,
      last_success_at: NOW,
      last_failure_at: null,
      failure_count: 2,
      last_failure_reason: null,
      test_requested_at: null,
    });
  });

  it('lists device health for the admin page, with and without the reason column', () => {
    expect(pushHealthPath()).toContain(',last_failure_reason&');
    expect(pushHealthPath(false)).not.toContain('last_failure_reason');
    const groups = groupByOwner([{ user_id: USER }, { user_id: OTHER }, { user_id: USER }]);
    expect(groups.get(USER)).toHaveLength(2);
    expect(groups.get(OTHER)).toHaveLength(1);
  });

  it('recognises the PostgREST missing-column errors only', () => {
    expect(isMissingColumnError(400, JSON.stringify({ code: '42703', message: 'column does not exist' }))).toBe(true);
    expect(isMissingColumnError(400, JSON.stringify({ code: 'PGRST204' }))).toBe(true);
    expect(isMissingColumnError(400, JSON.stringify({ code: '22P02' }))).toBe(false);
    expect(isMissingColumnError(500, JSON.stringify({ code: '42703' }))).toBe(false);
    expect(isMissingColumnError(400, 'not json')).toBe(false);
    expect(isMissingColumnError(400, '')).toBe(false);
  });
});

describe('admin device health labels', () => {
  it('names the platform of a device', () => {
    expect(devicePlatformLabel('ios')).toBe('iPhone/iPad');
    expect(devicePlatformLabel('android')).toBe('Android');
    expect(devicePlatformLabel('desktop')).toBe('Computadora');
    expect(devicePlatformLabel(null)).toBe('Dispositivo');
    expect(devicePlatformLabel('toaster')).toBe('Dispositivo');
  });

  it('marks a device failing only when its newest event is a failure', () => {
    const at = (h: number) => `2026-10-08T${String(h).padStart(2, '0')}:00:00.000Z`;
    expect(deviceFailing({ failure_count: 3, last_failure_at: at(13), last_success_at: at(12) })).toBe(true);
    expect(deviceFailing({ failure_count: 3, last_failure_at: at(11), last_success_at: at(12) })).toBe(false);
    expect(deviceFailing({ failure_count: null, last_failure_at: at(13), last_success_at: null })).toBe(true);
    expect(deviceFailing({ failure_count: 0, last_failure_at: at(13), last_success_at: at(12) })).toBe(true);
    expect(deviceFailing({ failure_count: 0, last_failure_at: null, last_success_at: null })).toBe(false);
  });
});
