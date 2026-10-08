import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const getCurrentUser = vi.fn();
vi.mock('@/lib/auth', () => ({ getCurrentUser: () => getCurrentUser() }));
const dbJson = vi.fn();
vi.mock('@/lib/db', () => ({ dbJson: (...args: unknown[]) => dbJson(...args), dbFetch: vi.fn() }));

const { DEGRADED_REASON_LABELS, WORKER_STATUS_PATH, getWorkerStatus, isStale, parseHeartbeat, serviceSummary, testPushWarning, vapidMismatch } = await import(
  '@/lib/worker-status'
);
const { POST } = await import('@/app/api/push/test/route');

const NOW = new Date('2026-10-08T12:00:00.000Z');
const KEY = 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';
const OTHER_KEY = `${KEY.slice(0, -1)}A`;
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000).toISOString();

describe('isStale', () => {
  it('is stale past 180 s, or without a readable instant', () => {
    expect(isStale(ago(60), NOW)).toBe(false);
    expect(isStale(ago(180), NOW)).toBe(false);
    expect(isStale(ago(181), NOW)).toBe(true);
    expect(isStale(null, NOW)).toBe(true);
    expect(isStale('yesterday', NOW)).toBe(true);
    expect(isStale(ago(30), NOW, 10)).toBe(true);
  });
});

describe('vapidMismatch', () => {
  it('only reports two known, different keys', () => {
    expect(vapidMismatch(KEY, KEY)).toBe(false);
    expect(vapidMismatch(`${KEY}=`, ` ${KEY} `)).toBe(false);
    expect(vapidMismatch(KEY, `${KEY.slice(0, -1)}A`)).toBe(true);
    expect(vapidMismatch(null, KEY)).toBe(false);
    expect(vapidMismatch(KEY, undefined)).toBe(false);
    expect(vapidMismatch('', '')).toBe(false);
  });
});

describe('parseHeartbeat', () => {
  it('reads the worker_status JSON and drops wrong types', () => {
    const hb = parseHeartbeat(
      JSON.stringify({
        at: ago(10),
        version: '2.1',
        webpush_enabled: true,
        push_status: 'ok',
        push_counts: { sent_ok: 3, failed: 1, server_errors: { 500: 1 } },
        users_ok: 4,
        users_err: 'x',
        last_round_mode: 'full',
        extra: 1,
      }),
    );
    expect(hb).toMatchObject({
      at: ago(10),
      version: '2.1',
      webpush_enabled: true,
      push_status: 'ok',
      push_counts: { sent_ok: 3, failed: 1 },
      users_ok: 4,
      users_err: null,
      last_round_mode: 'full',
      delivery_lag_seconds: null,
    });
  });

  it('accepts epoch seconds and milliseconds for at', () => {
    const seconds = NOW.getTime() / 1000;
    expect(parseHeartbeat(JSON.stringify({ at: seconds }))?.at).toBe(NOW.toISOString());
    expect(parseHeartbeat(JSON.stringify({ at: NOW.getTime() }))?.at).toBe(NOW.toISOString());
  });

  it('is null for a missing or unreadable value', () => {
    expect(parseHeartbeat(null)).toBeNull();
    expect(parseHeartbeat('')).toBeNull();
    expect(parseHeartbeat('{oops')).toBeNull();
    expect(parseHeartbeat('[1,2]')).toBeNull();
    expect(parseHeartbeat('"text"')).toBeNull();
  });
});

describe('testPushWarning', () => {
  const hb = (fields: Record<string, unknown>) => parseHeartbeat(JSON.stringify(fields));

  it('warns about a stopped worker first, then about disabled Web Push', () => {
    expect(testPushWarning(hb({ at: ago(600), webpush_enabled: false }), NOW)).toBe('worker_stale');
    expect(testPushWarning(hb({ at: ago(5), webpush_enabled: false }), NOW)).toBe('push_disabled');
    expect(testPushWarning(hb({ at: ago(5), webpush_enabled: true }), NOW)).toBeNull();
    expect(testPushWarning(hb({ at: ago(5) }), NOW)).toBeNull();
  });

  it('says nothing without a heartbeat (older worker: unknown)', () => {
    expect(testPushWarning(null, NOW)).toBeNull();
  });
});

describe('getWorkerStatus', () => {
  beforeEach(() => dbJson.mockReset());

  it('reads both settings rows in one request', async () => {
    dbJson.mockResolvedValueOnce([
      { key: 'worker_status', value: JSON.stringify({ at: ago(5), webpush_enabled: true }) },
      { key: 'vapid_public_key', value: ` ${KEY} ` },
    ]);
    const status = await getWorkerStatus();
    expect(dbJson.mock.calls[0][0]).toBe(WORKER_STATUS_PATH);
    expect(status.vapidPublicKey).toBe(KEY);
    expect(status.heartbeat?.webpush_enabled).toBe(true);
  });

  it('reports unknown when the worker wrote neither row', async () => {
    dbJson.mockResolvedValueOnce([]);
    expect(await getWorkerStatus()).toEqual({ heartbeat: null, vapidPublicKey: null });
  });
});

describe('POST /api/push/test warning', () => {
  const USER = '3f2c8a52-8d5e-4a0b-9f0e-6f3a1c2b4d5e';
  const HOST = 'tareas.example.com';
  const post = () =>
    new Request(`https://${HOST}/api/push/test`, {
      method: 'POST',
      headers: { host: HOST, origin: `https://${HOST}`, 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc' }),
    });

  beforeEach(() => {
    dbJson.mockReset();
    getCurrentUser.mockReset();
  });

  function route(path: string, heartbeat: unknown) {
    dbJson.mockImplementation(async (p: string) => {
      if (p === WORKER_STATUS_PATH) {
        if (heartbeat instanceof Error) throw heartbeat;
        return heartbeat === null ? [] : [{ key: 'worker_status', value: JSON.stringify(heartbeat) }];
      }
      expect(p).toContain(`user_id=eq.${path}`);
      return [{ id: 'x' }];
    });
  }

  it('still sets the flag but warns when the worker heartbeat is stale', async () => {
    getCurrentUser.mockResolvedValue({ id: USER });
    route(USER, { at: '2000-01-01T00:00:00.000Z', webpush_enabled: true });
    const res = await POST(post());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.warning).toBe('worker_stale');
    expect(Number.isNaN(Date.parse(body.requestedAt))).toBe(false);
  });

  it('has no warning with a fresh heartbeat, without one, or when the status cannot be read', async () => {
    getCurrentUser.mockResolvedValue({ id: '11111111-2222-3333-4444-555555555555' });
    route('11111111-2222-3333-4444-555555555555', { at: new Date().toISOString(), webpush_enabled: true });
    expect((await (await POST(post())).json()).warning).toBeUndefined();

    getCurrentUser.mockResolvedValue({ id: '22222222-2222-3333-4444-555555555555' });
    route('22222222-2222-3333-4444-555555555555', null);
    expect((await (await POST(post())).json()).warning).toBeUndefined();

    getCurrentUser.mockResolvedValue({ id: '33333333-2222-3333-4444-555555555555' });
    route('33333333-2222-3333-4444-555555555555', new Error('settings down'));
    const body = await (await POST(post())).json();
    expect(body.ok).toBe(true);
    expect(body.warning).toBeUndefined();
  });

  it('warns when Web Push is disabled on the worker', async () => {
    getCurrentUser.mockResolvedValue({ id: '44444444-2222-3333-4444-555555555555' });
    route('44444444-2222-3333-4444-555555555555', { at: new Date().toISOString(), webpush_enabled: false });
    expect((await (await POST(post())).json()).warning).toBe('push_disabled');
  });
});

describe('serviceSummary (admin card)', () => {
  const status = (heartbeat: Record<string, unknown> | null, vapidPublicKey: string | null = KEY) => ({
    heartbeat: heartbeat ? parseHeartbeat(JSON.stringify(heartbeat)) : null,
    vapidPublicKey,
  });

  it('shows a live worker, Web Push enabled, its counters and round mode', () => {
    const summary = serviceSummary(
      status({ at: ago(20), webpush_enabled: true, push_status: 'ok', push_counts: { sent_ok: 4, gone: 1 }, last_round_mode: 'full' }),
      KEY,
      NOW,
    );
    expect(summary.worker).toEqual({ text: 'Activo (latido hace 20 s)', tone: 'activo' });
    expect(summary.push).toEqual({ text: 'Web Push activo (ok)', tone: 'activo' });
    expect(summary.counts).toBe('sent_ok 4 · gone 1');
    expect(summary.roundMode).toBe('full');
    expect(summary.vapidMismatch).toBe(false);
  });

  it('flags a stopped worker, disabled Web Push and a VAPID mismatch', () => {
    const summary = serviceSummary(status({ at: ago(600), webpush_enabled: false, push_status: 'key_mismatch' }), OTHER_KEY, NOW);
    expect(summary.worker).toEqual({ text: 'Detenido (último latido hace 10 min)', tone: 'urgente' });
    expect(summary.push).toEqual({ text: 'Web Push desactivado (key_mismatch)', tone: 'urgente' });
    expect(summary.vapidMismatch).toBe(true);
  });

  it('lists the degraded reasons the worker reports, with labels for the known ones', () => {
    const summary = serviceSummary(
      status({ at: ago(20), webpush_enabled: false, degraded: true, degraded_reasons: ['webpush_disabled', 'new_reason', 3] }),
      KEY,
      NOW,
    );
    expect(summary.degraded).toEqual([DEGRADED_REASON_LABELS.webpush_disabled, 'new_reason']);
    expect(serviceSummary(status({ at: ago(20), degraded: false, degraded_reasons: ['webpush_disabled'] }), KEY, NOW).degraded).toEqual([]);
    expect(serviceSummary(status({ at: ago(20) }), KEY, NOW).degraded).toEqual([]);
  });

  it('says unknown when the worker reports nothing or the read failed', () => {
    for (const s of [status(null, null), null]) {
      const summary = serviceSummary(s, KEY, NOW);
      expect(summary.worker.tone).toBe('finalizado');
      expect(summary.push.text).toBe('Web Push: desconocido');
      expect(summary.counts).toBeNull();
      expect(summary.vapidMismatch).toBe(false);
    }
  });
});
