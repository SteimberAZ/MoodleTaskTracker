import { describe, expect, it } from 'vitest';
import { SESSION_MAX_AGE_SECONDS, safeEqual, signSession, verifySession } from '@/lib/session-token';

const SECRET = 'test-secret-value';
const NOW = 1_800_000_000_000;

describe('session token', () => {
  it('verifies a freshly signed token', async () => {
    const token = await signSession(SECRET, NOW);
    expect(await verifySession(SECRET, token, NOW + 1000)).toBe(true);
  });

  it('rejects a token signed with another secret', async () => {
    const token = await signSession('other-secret', NOW);
    expect(await verifySession(SECRET, token, NOW)).toBe(false);
  });

  it('rejects a tampered expiry', async () => {
    const [v, exp, sig] = (await signSession(SECRET, NOW)).split('.');
    const forged = `${v}.${Number(exp) + 99999}.${sig}`;
    expect(await verifySession(SECRET, forged, NOW)).toBe(false);
  });

  it('rejects expired tokens', async () => {
    const token = await signSession(SECRET, NOW);
    expect(await verifySession(SECRET, token, NOW + (SESSION_MAX_AGE_SECONDS + 1) * 1000)).toBe(false);
  });

  it('rejects missing secret, missing token and garbage', async () => {
    const token = await signSession(SECRET, NOW);
    expect(await verifySession(undefined, token, NOW)).toBe(false);
    expect(await verifySession(SECRET, undefined, NOW)).toBe(false);
    expect(await verifySession(SECRET, 'garbage', NOW)).toBe(false);
    expect(await verifySession(SECRET, 'v1.abc.def', NOW)).toBe(false);
  });
});

describe('safeEqual', () => {
  it('compares strings of any length', async () => {
    expect(await safeEqual('abc', 'abc')).toBe(true);
    expect(await safeEqual('abc', 'abd')).toBe(false);
    expect(await safeEqual('abc', 'abcd')).toBe(false);
    expect(await safeEqual('', '')).toBe(true);
  });
});
