import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  THROTTLED_MESSAGE,
  canonicalUsername,
  createLoginThrottle,
  decide,
  isCredentialFailure,
  throttleKey,
  throttleKeys,
  type RpcCall,
} from '@/lib/login-throttle';
import { GENERIC_MOODLE_ERROR, moodleErrorMessage } from '@/lib/moodle';

const KEYS = { key: 'a'.repeat(64), userKey: 'b'.repeat(64) };

/** RPC adapter over a mocked global fetch, shaped like the real one in app/login/actions.ts. */
const rpcOverFetch: RpcCall = (fn, args) =>
  fetch(`https://db.example.com/rest/v1/rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) });

const calledFn = (mock: ReturnType<typeof vi.fn>, i: number) => String(mock.mock.calls[i][0]).split('/rpc/')[1];
const calledBody = (mock: ReturnType<typeof vi.fn>, i: number) =>
  JSON.parse(String((mock.mock.calls[i][1] as RequestInit).body));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('throttle keys', () => {
  it('is the sha256 hex of the canonical username', () => {
    expect(throttleKey('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(throttleKey('e1234')).not.toBe(throttleKey('e1235'));
  });

  it('maps the institutional e-mail and the bare username to one account', () => {
    expect(canonicalUsername('  E1234@UTM.edu.ec ')).toBe('e1234');
    expect(throttleKey('e1234@utm.edu.ec')).toBe(throttleKey('E1234'));
    expect(canonicalUsername('ana@gmail.com')).toBe('ana@gmail.com'); // another domain is another identity
  });

  it('keys the hard block by account and client, the ceiling by account only', () => {
    const a = throttleKeys('e1234@utm.edu.ec', '203.0.113.7');
    const b = throttleKeys('E1234', '198.51.100.9');
    expect(a.userKey).toBe(b.userKey);
    expect(a.key).not.toBe(b.key);
    expect(throttleKeys('e1234', '').key).toBe(throttleKeys('e1234', ' ').key);
  });

  it('never contains the username or the address itself', () => {
    const keys = throttleKeys('e1234567890', '203.0.113.7');
    expect(keys.key).toMatch(/^[0-9a-f]{64}$/);
    expect(keys.userKey).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('decide', () => {
  it('allows when the RPC answers 0 or nothing usable', () => {
    expect(decide(0)).toEqual({ allowed: true });
    expect(decide(-5)).toEqual({ allowed: true });
    expect(decide(null)).toEqual({ allowed: true });
    expect(decide(Number.NaN)).toEqual({ allowed: true });
  });

  it('blocks while the RPC reports blocked seconds', () => {
    expect(decide(120)).toEqual({ allowed: false, retryAfterSeconds: 120 });
    expect(decide(0.2)).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });

  it('keeps the agreed Spanish message', () => {
    expect(THROTTLED_MESSAGE).toBe('Demasiados intentos. Espera unos minutos e inténtalo de nuevo.');
  });
});

describe('isCredentialFailure', () => {
  it('counts only a rejected username or password', () => {
    expect(isCredentialFailure(moodleErrorMessage('invalidlogin'))).toBe(true);
    expect(isCredentialFailure(moodleErrorMessage('usernamenotfound'))).toBe(true);
    expect(isCredentialFailure(GENERIC_MOODLE_ERROR)).toBe(false);
    expect(isCredentialFailure(moodleErrorMessage('sitemaintenance'))).toBe(false);
  });
});

describe('createLoginThrottle', () => {
  it('reserves the attempt with both keys and blocks on a positive answer', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response('300'));
    vi.stubGlobal('fetch', fetchMock);
    const throttle = createLoginThrottle(rpcOverFetch, vi.fn());
    expect(await throttle.begin(KEYS)).toEqual({ allowed: false, retryAfterSeconds: 300 });
    expect(calledFn(fetchMock, 0)).toBe('moodle_login_begin');
    expect(calledBody(fetchMock, 0)).toEqual({ p_key_hash: KEYS.key, p_user_key_hash: KEYS.userKey });
  });

  it('allows on a 0 answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('0')));
    expect(await createLoginThrottle(rpcOverFetch, vi.fn()).begin(KEYS)).toEqual({ allowed: true });
  });

  it('settles the reservation with its outcome', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const warn = vi.fn();
    const throttle = createLoginThrottle(rpcOverFetch, warn);
    await throttle.finish(KEYS, 'failure');
    await throttle.finish(KEYS, 'released');
    expect(calledFn(fetchMock, 0)).toBe('moodle_login_finish');
    expect(calledBody(fetchMock, 0)).toEqual({ p_key_hash: KEYS.key, p_user_key_hash: KEYS.userKey, p_outcome: 'failure' });
    expect(calledBody(fetchMock, 1).p_outcome).toBe('released');
    expect(warn).not.toHaveBeenCalled();
  });

  it('falls back to the older gate/result RPCs on the account key when the new ones are missing', async () => {
    const fetchMock = vi.fn(async (url: string, _init: RequestInit) =>
      url.endsWith('moodle_login_begin') ? new Response('{"code":"PGRST202"}', { status: 404 }) : new Response('0'),
    );
    vi.stubGlobal('fetch', fetchMock);
    const warn = vi.fn();
    const throttle = createLoginThrottle(rpcOverFetch, warn);
    expect(await throttle.begin(KEYS)).toEqual({ allowed: true });
    expect(calledFn(fetchMock, 1)).toBe('moodle_login_gate');
    expect(calledBody(fetchMock, 1)).toEqual({ p_key_hash: KEYS.userKey });
    await throttle.finish(KEYS, 'released'); // nothing was reserved: no call
    await throttle.finish(KEYS, 'failure');
    expect(calledFn(fetchMock, 2)).toBe('moodle_login_result');
    expect(calledBody(fetchMock, 2)).toEqual({ p_key_hash: KEYS.userKey, p_success: false });
    await throttle.begin(KEYS);
    expect(calledFn(fetchMock, 3)).toBe('moodle_login_gate'); // the missing RPC is not asked again
    expect(warn).not.toHaveBeenCalled();
  });

  it('fails open when no throttle RPC exists and warns only once', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"message":"function not found"}', { status: 404 })));
    const warn = vi.fn();
    const throttle = createLoginThrottle(rpcOverFetch, warn);
    expect(await throttle.begin(KEYS)).toEqual({ allowed: true });
    await throttle.finish(KEYS, 'failure');
    expect(await throttle.begin(KEYS)).toEqual({ allowed: true });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).not.toContain(KEYS.key);
    expect(warn.mock.calls[0]).not.toContain(KEYS.userKey);
  });

  it('fails open when the fetch rejects (timeout) or answers garbage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('timeout', 'TimeoutError');
      }),
    );
    const warn = vi.fn();
    const throttle = createLoginThrottle(rpcOverFetch, warn);
    expect(await throttle.begin(KEYS)).toEqual({ allowed: true });
    await expect(throttle.finish(KEYS, 'success')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('Login throttle unavailable, allowing the attempt', 'moodle_login_begin', 'TimeoutError');

    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json')));
    expect(await createLoginThrottle(rpcOverFetch, vi.fn()).begin(KEYS)).toEqual({ allowed: true });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('"abc"')));
    expect(await createLoginThrottle(rpcOverFetch, vi.fn()).begin(KEYS)).toEqual({ allowed: true });
  });
});
