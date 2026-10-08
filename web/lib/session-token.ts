// Web Crypto only, so it runs in middleware (edge) and in Node route handlers/actions alike.
export const SESSION_COOKIE = 'moddle_session';
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

const encoder = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

/** Constant-time string comparison (both sides are hashed first so lengths do not leak). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b)),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

/** Label that domain-separates the derived session key from any other use of the database JWT. */
const DERIVED_SECRET_LABEL = 'moddle-session-secret-v1';

/**
 * Session signing secret: `SESSION_SECRET` when set; otherwise derived from `MOODLE_DB_JWT`
 * (already a deployment secret) with HMAC-SHA256, so no extra variable has to be configured.
 * The derivation is deterministic, so every serverless instance agrees on the same key.
 * Rotating `MOODLE_DB_JWT` without a `SESSION_SECRET` logs every user out.
 */
export async function resolveSessionSecret(
  env: Record<string, string | undefined> = process.env,
): Promise<string | undefined> {
  const explicit = env.SESSION_SECRET?.trim();
  if (explicit) return explicit;
  const dbJwt = env.MOODLE_DB_JWT?.trim();
  if (!dbJwt) return undefined;
  return hmacHex(dbJwt, DERIVED_SECRET_LABEL);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Token format: `v2.<userId>.<expiresAtSeconds>.<hmacHex>` (the user id is a UUID, so it has no dots). */
export async function signSession(secret: string, userId: string, nowMs: number = Date.now()): Promise<string> {
  if (!secret) throw new Error('Session secret is not configured (set SESSION_SECRET or MOODLE_DB_JWT)');
  if (!UUID.test(userId)) throw new Error('Invalid user id for session');
  const exp = Math.floor(nowMs / 1000) + SESSION_MAX_AGE_SECONDS;
  const payload = `v2.${userId}.${exp}`;
  return `${payload}.${await hmacHex(secret, payload)}`;
}

/**
 * Verifies signature and expiry only (no database access, so it can run in middleware).
 * Returns the user id the token was issued for, or null when the token is invalid.
 */
export async function verifySession(
  secret: string | undefined,
  token: string | undefined,
  nowMs: number = Date.now(),
): Promise<string | null> {
  if (!secret || !token) return null;
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'v2' || !UUID.test(parts[1]) || !/^\d+$/.test(parts[2])) return null;
  if (Number(parts[2]) * 1000 <= nowMs) return null;
  const expected = await hmacHex(secret, `${parts[0]}.${parts[1]}.${parts[2]}`);
  return (await safeEqual(expected, parts[3])) ? parts[1] : null;
}
