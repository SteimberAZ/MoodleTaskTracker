import { describe, expect, it } from 'vitest';
import { SESSION_MAX_AGE_SECONDS, resolveSessionSecret, safeEqual, signSession, verifySession } from '@/lib/session-token';

const SECRET = 'test-secret-value';
const NOW = 1_800_000_000_000;
const USER = '3f2c8a52-8d5e-4a0b-9f0e-6f3a1c2b4d5e';
const OTHER_USER = '11111111-2222-3333-4444-555555555555';

describe('session token v2', () => {
  it('round-trips the user id of a freshly signed token', async () => {
    const token = await signSession(SECRET, USER, NOW);
    expect(token.startsWith(`v2.${USER}.`)).toBe(true);
    expect(await verifySession(SECRET, token, NOW + 1000)).toBe(USER);
  });

  it('rejects a token signed with another secret', async () => {
    const token = await signSession('other-secret', USER, NOW);
    expect(await verifySession(SECRET, token, NOW)).toBeNull();
  });

  it('rejects a tampered expiry', async () => {
    const [v, id, exp, sig] = (await signSession(SECRET, USER, NOW)).split('.');
    const forged = `${v}.${id}.${Number(exp) + 99999}.${sig}`;
    expect(await verifySession(SECRET, forged, NOW)).toBeNull();
  });

  it('rejects a swapped user id (privilege escalation attempt)', async () => {
    const [v, , exp, sig] = (await signSession(SECRET, USER, NOW)).split('.');
    expect(await verifySession(SECRET, `${v}.${OTHER_USER}.${exp}.${sig}`, NOW)).toBeNull();
  });

  it('rejects a tampered signature', async () => {
    const token = await signSession(SECRET, USER, NOW);
    const flipped = token.slice(0, -1) + (token.endsWith('0') ? '1' : '0');
    expect(await verifySession(SECRET, flipped, NOW)).toBeNull();
  });

  it('rejects expired tokens', async () => {
    const token = await signSession(SECRET, USER, NOW);
    expect(await verifySession(SECRET, token, NOW + (SESSION_MAX_AGE_SECONDS + 1) * 1000)).toBeNull();
  });

  it('rejects missing secret, missing token, garbage and the legacy v1 format', async () => {
    const token = await signSession(SECRET, USER, NOW);
    const future = Math.floor(NOW / 1000) + 1000;
    expect(await verifySession(undefined, token, NOW)).toBeNull();
    expect(await verifySession(SECRET, undefined, NOW)).toBeNull();
    expect(await verifySession(SECRET, 'garbage', NOW)).toBeNull();
    expect(await verifySession(SECRET, 'v1.abc.def', NOW)).toBeNull();
    expect(await verifySession(SECRET, `v1.${future}.abcdef`, NOW)).toBeNull();
    expect(await verifySession(SECRET, `v2.not-a-uuid.${future}.abcdef`, NOW)).toBeNull();
  });

  it('refuses to sign for an empty secret or a non-UUID user id', async () => {
    await expect(signSession('', USER, NOW)).rejects.toThrow();
    await expect(signSession(SECRET, 'a.b', NOW)).rejects.toThrow();
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

describe('resolveSessionSecret', () => {
  it('prefers an explicit SESSION_SECRET', async () => {
    expect(await resolveSessionSecret({ SESSION_SECRET: ' explicit ', MOODLE_DB_JWT: 'jwt' })).toBe('explicit');
  });

  it('derives a stable secret from MOODLE_DB_JWT when SESSION_SECRET is unset', async () => {
    const a = await resolveSessionSecret({ MOODLE_DB_JWT: 'jwt-value' });
    const b = await resolveSessionSecret({ MOODLE_DB_JWT: 'jwt-value', SESSION_SECRET: '' });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toBe(a);
    expect(a).not.toContain('jwt-value');
  });

  it('derives different secrets for different JWTs', async () => {
    expect(await resolveSessionSecret({ MOODLE_DB_JWT: 'one' })).not.toBe(await resolveSessionSecret({ MOODLE_DB_JWT: 'two' }));
  });

  it('returns undefined when neither variable is set', async () => {
    expect(await resolveSessionSecret({})).toBeUndefined();
  });

  it('signs and verifies sessions with the derived secret', async () => {
    const secret = (await resolveSessionSecret({ MOODLE_DB_JWT: 'jwt-value' }))!;
    const userId = '0b5b0c0e-8a3f-4c7d-9a1e-2f3b4c5d6e7f';
    expect(await verifySession(secret, await signSession(secret, userId))).toBe(userId);
  });
});
