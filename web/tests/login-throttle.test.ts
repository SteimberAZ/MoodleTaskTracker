import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  THROTTLED_MESSAGE,
  createLoginThrottle,
  decide,
  isCredentialFailure,
  throttleKey,
  type RpcCall,
} from '@/lib/login-throttle';
import { GENERIC_MOODLE_ERROR, moodleErrorMessage } from '@/lib/moodle';

const KEY = 'a'.repeat(64);

/** RPC adapter over a mocked global fetch, shaped like the real one in app/login/actions.ts. */
const rpcOverFetch: RpcCall = (fn, args) =>
  fetch(`https://db.example.com/rest/v1/rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('throttleKey', () => {
  it('is the sha256 hex of the trimmed, lowercased username', () => {
    expect(throttleKey('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(throttleKey('  E1234@UTM.edu.ec ')).toBe(throttleKey('e1234@utm.edu.ec'));
    expect(throttleKey('e1234')).not.toBe(throttleKey('e1235'));
  });

  it('never contains the username itself', () => {
    expect(throttleKey('e1234567890')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('decide', () => {
  it('allows when the gate answers 0 or nothing usable', () => {
    expect(decide(0)).toEqual({ allowed: true });
    expect(decide(-5)).toEqual({ allowed: true });
    expect(decide(null)).toEqual({ allowed: true });
    expect(decide(Number.NaN)).toEqual({ allowed: true });
  });

  it('blocks while the gate reports blocked seconds', () => {
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
  it('calls the gate with the key hash and blocks on a positive answer', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response('300'));
    vi.stubGlobal('fetch', fetchMock);
    const throttle = createLoginThrottle(rpcOverFetch, vi.fn());
    expect(await throttle.gate(KEY)).toEqual({ allowed: false, retryAfterSeconds: 300 });
    expect(fetchMock.mock.calls[0][0]).toBe('https://db.example.com/rest/v1/rpc/moodle_login_gate');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({ p_key_hash: KEY });
  });

  it('allows on a 0 answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('0')));
    expect(await createLoginThrottle(rpcOverFetch, vi.fn()).gate(KEY)).toEqual({ allowed: true });
  });

  it('records the result with p_success', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const warn = vi.fn();
    await createLoginThrottle(rpcOverFetch, warn).record(KEY, false);
    expect(fetchMock.mock.calls[0][0]).toBe('https://db.example.com/rest/v1/rpc/moodle_login_result');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({ p_key_hash: KEY, p_success: false });
    expect(warn).not.toHaveBeenCalled();
  });

  it('fails open when the RPC is missing (404) and warns only once', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"message":"function not found"}', { status: 404 })));
    const warn = vi.fn();
    const throttle = createLoginThrottle(rpcOverFetch, warn);
    expect(await throttle.gate(KEY)).toEqual({ allowed: true });
    await throttle.record(KEY, false);
    expect(await throttle.gate(KEY)).toEqual({ allowed: true });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).not.toContain(KEY);
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
    expect(await throttle.gate(KEY)).toEqual({ allowed: true });
    await expect(throttle.record(KEY, true)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('Login throttle unavailable, allowing the attempt', 'moodle_login_gate', 'TimeoutError');

    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json')));
    expect(await createLoginThrottle(rpcOverFetch, vi.fn()).gate(KEY)).toEqual({ allowed: true });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('"abc"')));
    expect(await createLoginThrottle(rpcOverFetch, vi.fn()).gate(KEY)).toEqual({ allowed: true });
  });
});
