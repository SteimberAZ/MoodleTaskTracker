import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const getCurrentUser = vi.fn();
vi.mock('@/lib/auth', () => ({ getCurrentUser: () => getCurrentUser() }));

const { authorizePushRequest, authorizePushSession } = await import('@/lib/push-api');

const USER = {
  id: '3f2c8a52-8d5e-4a0b-9f0e-6f3a1c2b4d5e',
  username: 'u',
  fullname: null,
  ntfy_topic: 't',
  is_admin: false,
  active: true,
  last_error: null,
};
const HOST = 'tareas.example.com';

function post(body: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://${HOST}/api/push/subscribe`, {
    method: 'POST',
    headers: { host: HOST, origin: `https://${HOST}`, 'content-type': 'application/json', ...headers },
    body,
  });
}

beforeEach(() => {
  getCurrentUser.mockReset();
  getCurrentUser.mockResolvedValue(USER);
});

describe('authorizePushRequest', () => {
  it('passes a same-origin, authenticated JSON request with its parsed body', async () => {
    const result = await authorizePushRequest(post('{"a":1}'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.user.id).toBe(USER.id);
      expect(result.body).toEqual({ a: 1 });
    }
  });

  it('refuses another Origin with 403 before reading the session', async () => {
    const result = await authorizePushRequest(post('{}', { origin: 'https://evil.example' }));
    expect(!result.ok && result.response.status).toBe(403);
    expect(getCurrentUser).not.toHaveBeenCalled();
  });

  it('answers 503 when the session cannot be verified and 401 without a user', async () => {
    getCurrentUser.mockRejectedValueOnce(new Error('db down'));
    const down = await authorizePushRequest(post('{}'));
    expect(!down.ok && down.response.status).toBe(503);
    getCurrentUser.mockResolvedValueOnce(null);
    const anon = await authorizePushRequest(post('{}'));
    expect(!anon.ok && anon.response.status).toBe(401);
    if (!anon.ok) {
      expect(anon.response.headers.get('cache-control')).toBe('no-store');
      expect(await anon.response.json()).toEqual({ error: 'No autorizado.' });
    }
  });

  it('requires a JSON content type (415)', async () => {
    const result = await authorizePushRequest(post('{}', { 'content-type': 'text/plain' }));
    expect(!result.ok && result.response.status).toBe(415);
  });

  it('refuses bodies over 8 KiB, declared or actual (413)', async () => {
    const declared = await authorizePushRequest(post('{}', { 'content-length': String(9 * 1024) }));
    expect(!declared.ok && declared.response.status).toBe(413);
    const actual = await authorizePushRequest(post(JSON.stringify({ pad: 'x'.repeat(9 * 1024) })));
    expect(!actual.ok && actual.response.status).toBe(413);
  });

  it('answers 400 to malformed JSON', async () => {
    const result = await authorizePushRequest(post('{not json'));
    expect(!result.ok && result.response.status).toBe(400);
  });
});

describe('authorizePushSession (GET handlers)', () => {
  const get = (headers: Record<string, string> = {}) =>
    new Request(`https://${HOST}/api/push/status?endpoint=x`, { headers: { host: HOST, ...headers } });

  it('needs no body or content type', async () => {
    const result = await authorizePushSession(get({ 'sec-fetch-site': 'same-origin' }));
    expect(result.ok && result.user.id).toBe(USER.id);
  });

  it('applies the same origin and session checks', async () => {
    const cross = await authorizePushSession(get({ 'sec-fetch-site': 'cross-site' }));
    expect(!cross.ok && cross.response.status).toBe(403);
    getCurrentUser.mockResolvedValueOnce(null);
    const anon = await authorizePushSession(get());
    expect(!anon.ok && anon.response.status).toBe(401);
  });
});
