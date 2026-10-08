import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const getCurrentUser = vi.fn();
vi.mock('@/lib/auth', () => ({ getCurrentUser: () => getCurrentUser() }));
const dbFetch = vi.fn();
vi.mock('@/lib/db', () => ({ dbFetch: (...args: unknown[]) => dbFetch(...args), dbJson: vi.fn() }));

const { GET } = await import('@/app/api/push/status/route');

const USER = '3f2c8a52-8d5e-4a0b-9f0e-6f3a1c2b4d5e';
const HOST = 'tareas.example.com';
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc:APA91b_-xyz';
const ROW = {
  last_success_at: '2026-10-08T12:00:00.000Z',
  last_failure_at: '2026-10-08T13:00:00.000Z',
  failure_count: 2,
  last_failure_reason: 'http_404',
  test_requested_at: null,
};

const respond = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) }) as unknown as Response;

function request(endpoint: string | null = ENDPOINT): Request {
  const query = endpoint === null ? '' : `?endpoint=${encodeURIComponent(endpoint)}`;
  return new Request(`https://${HOST}/api/push/status${query}`, { headers: { host: HOST, origin: `https://${HOST}` } });
}

beforeEach(() => {
  getCurrentUser.mockReset();
  getCurrentUser.mockResolvedValue({ id: USER });
  dbFetch.mockReset();
});

describe('GET /api/push/status', () => {
  it('reads the device scoped to the session user and returns its health', async () => {
    dbFetch.mockResolvedValueOnce(respond(200, [ROW]));
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ registered: true, ...ROW });
    const path = dbFetch.mock.calls[0][0] as string;
    expect(path.startsWith(`moodle_push_subscriptions?user_id=eq.${USER}&endpoint=eq.${encodeURIComponent(ENDPOINT)}&`)).toBe(true);
  });

  it('reports registered false when the server has no row for this device', async () => {
    dbFetch.mockResolvedValueOnce(respond(200, []));
    const body = await (await GET(request())).json();
    expect(body.registered).toBe(false);
    expect(body.failure_count).toBe(0);
  });

  it('treats a missing last_failure_reason column as null', async () => {
    const { last_failure_reason: _reason, ...legacy } = ROW;
    dbFetch
      .mockResolvedValueOnce(respond(400, { code: '42703', message: 'column last_failure_reason does not exist' }))
      .mockResolvedValueOnce(respond(200, [legacy]));
    const body = await (await GET(request())).json();
    expect(body).toEqual({ registered: true, ...ROW, last_failure_reason: null });
    expect(dbFetch.mock.calls[0][0]).toContain('last_failure_reason');
    expect(dbFetch.mock.calls[1][0]).not.toContain('last_failure_reason');
  });

  it('answers 502 on other database errors and 400 without a valid endpoint', async () => {
    dbFetch.mockResolvedValueOnce(respond(500, { code: 'XX000' }));
    expect((await GET(request())).status).toBe(502);
    expect(dbFetch).toHaveBeenCalledTimes(1);
    expect((await GET(request(null))).status).toBe(400);
    expect((await GET(request('http://fcm.googleapis.com/x'))).status).toBe(400);
  });

  it('requires a session', async () => {
    getCurrentUser.mockResolvedValueOnce(null);
    expect((await GET(request())).status).toBe(401);
    expect(dbFetch).not.toHaveBeenCalled();
  });
});
