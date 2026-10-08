import { describe, expect, it } from 'vitest';
import {
  SESSION_ABSOLUTE_MAX_SECONDS,
  SESSION_COOKIE_OPTIONS,
  SESSION_MAX_AGE_SECONDS,
  hmacHex,
  SESSION_RENEW_THRESHOLD_SECONDS,
  resolveSessionSecret,
  safeEqual,
  shouldRenewSession,
  signSession,
  verifySession,
  verifySessionWithExp,
} from '@/lib/session-token';

const SECRET = 'test-secret-value';
const NOW = 1_800_000_000_000;
const USER = '3f2c8a52-8d5e-4a0b-9f0e-6f3a1c2b4d5e';
const OTHER_USER = '11111111-2222-3333-4444-555555555555';

describe('session token v2', () => {
  it('round-trips the user id of a freshly signed token', async () => {
    const token = await signSession(SECRET, USER, NOW);
    expect(token.startsWith(`v3.${USER}.`)).toBe(true);
    expect(await verifySession(SECRET, token, NOW + 1000)).toBe(USER);
  });

  it('rejects a token signed with another secret', async () => {
    const token = await signSession('other-secret', USER, NOW);
    expect(await verifySession(SECRET, token, NOW)).toBeNull();
  });

  it('rejects a tampered expiry', async () => {
    const [v, id, exp, iat, sig] = (await signSession(SECRET, USER, NOW)).split('.');
    const forged = `${v}.${id}.${Number(exp) + 99999}.${iat}.${sig}`;
    expect(await verifySession(SECRET, forged, NOW)).toBeNull();
  });

  it('rejects a swapped user id (privilege escalation attempt)', async () => {
    const [v, , exp, iat, sig] = (await signSession(SECRET, USER, NOW)).split('.');
    expect(await verifySession(SECRET, `${v}.${OTHER_USER}.${exp}.${iat}.${sig}`, NOW)).toBeNull();
  });

  it('rejects a tampered issued-at (the absolute lifetime cannot be extended)', async () => {
    const [v, id, exp, iat, sig] = (await signSession(SECRET, USER, NOW)).split('.');
    expect(await verifySession(SECRET, `${v}.${id}.${exp}.${Number(iat) + 86400}.${sig}`, NOW)).toBeNull();
  });

  it('still accepts a valid legacy v2 token until it expires', async () => {
    const exp = Math.floor(NOW / 1000) + 1000;
    const payload = `v2.${USER}.${exp}`;
    const legacy = `${payload}.${await hmacHex(SECRET, payload)}`;
    expect(await verifySessionWithExp(SECRET, legacy, NOW)).toEqual({ userId: USER, exp, iat: exp - SESSION_MAX_AGE_SECONDS });
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

describe('verifySessionWithExp', () => {
  it('returns the user id and the signed expiry', async () => {
    const token = await signSession(SECRET, USER, NOW);
    expect(await verifySessionWithExp(SECRET, token, NOW)).toEqual({
      userId: USER,
      exp: Math.floor(NOW / 1000) + SESSION_MAX_AGE_SECONDS,
      iat: Math.floor(NOW / 1000),
    });
  });

  it('returns null for an invalid or expired token', async () => {
    const token = await signSession(SECRET, USER, NOW);
    expect(await verifySessionWithExp('other-secret', token, NOW)).toBeNull();
    expect(await verifySessionWithExp(SECRET, token, NOW + SESSION_MAX_AGE_SECONDS * 1000)).toBeNull();
  });
});

describe('rolling session', () => {
  const exp = Math.floor(NOW / 1000) + SESSION_MAX_AGE_SECONDS;

  it('does not renew a session with more than the threshold left', () => {
    expect(shouldRenewSession(exp, NOW)).toBe(false);
    expect(shouldRenewSession(exp, (exp - SESSION_RENEW_THRESHOLD_SECONDS) * 1000)).toBe(false);
  });

  it('renews a session inside its last week', () => {
    expect(SESSION_RENEW_THRESHOLD_SECONDS).toBe(7 * 24 * 60 * 60);
    expect(shouldRenewSession(exp, (exp - SESSION_RENEW_THRESHOLD_SECONDS) * 1000 + 1)).toBe(true);
    expect(shouldRenewSession(exp, (exp - 60) * 1000)).toBe(true);
  });

  it('re-signing yields a token valid for a full period again', async () => {
    const later = (exp - 3600) * 1000;
    const renewed = await signSession(SECRET, USER, later);
    const verified = await verifySessionWithExp(SECRET, renewed, later);
    expect(verified?.exp).toBe(Math.floor(later / 1000) + SESSION_MAX_AGE_SECONDS);
    expect(shouldRenewSession(verified!.exp, later)).toBe(false);
  });

  it('keeps the original sign-in and never renews past the absolute lifetime', async () => {
    const iat = Math.floor(NOW / 1000);
    let token = await signSession(SECRET, USER, NOW);
    let now = NOW;
    let renewals = 0;
    // Replay the cookie once inside every last week, as a stolen token would be.
    for (let i = 0; i < 20; i++) {
      const session = await verifySessionWithExp(SECRET, token, now);
      if (!session) break;
      expect(session.iat).toBe(iat);
      now = (session.exp - 3600) * 1000;
      const current = await verifySessionWithExp(SECRET, token, now);
      if (!current || !shouldRenewSession(current.exp, now, current.iat)) break;
      token = await signSession(SECRET, USER, now, current.iat);
      renewals += 1;
    }
    expect(renewals).toBeGreaterThan(0);
    const last = await verifySessionWithExp(SECRET, token, now);
    expect(last!.exp).toBeLessThanOrEqual(iat + SESSION_ABSOLUTE_MAX_SECONDS);
    expect(await verifySession(SECRET, token, (iat + SESSION_ABSOLUTE_MAX_SECONDS) * 1000)).toBeNull();
  });

  it('shares one set of cookie options', () => {
    expect(SESSION_COOKIE_OPTIONS).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/', maxAge: SESSION_MAX_AGE_SECONDS });
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
