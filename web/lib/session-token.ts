// Web Crypto only, so it runs in middleware (edge) and in Node route handlers/actions alike.
export const SESSION_COOKIE = 'moddle_session';
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
/** A session closer than this to its expiry is re-signed by the middleware (rolling session). */
export const SESSION_RENEW_THRESHOLD_SECONDS = 7 * 24 * 60 * 60;
/**
 * Absolute lifetime of one login: the rolling renewal never extends a session past its original sign-in
 * (`iat`) plus this, so a copied cookie cannot be kept alive forever by replaying it.
 */
export const SESSION_ABSOLUTE_MAX_SECONDS = 90 * 24 * 60 * 60;

/** Cookie attributes shared by the login (`startSession`) and the middleware renewal. */
export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  path: '/',
  maxAge: SESSION_MAX_AGE_SECONDS,
} as const;

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

/** Expiry of a session signed at `nowSeconds` for a login made at `iat`: a full period, capped at the absolute lifetime. */
function sessionExpiry(nowSeconds: number, iat: number): number {
  return Math.min(nowSeconds + SESSION_MAX_AGE_SECONDS, iat + SESSION_ABSOLUTE_MAX_SECONDS);
}

/**
 * Token format: `v3.<userId>.<expiresAtSeconds>.<issuedAtSeconds>.<hmacHex>` (the user id is a UUID, so it has
 * no dots). `issuedAtSeconds` is the original sign-in: a renewal passes it on unchanged.
 */
export async function signSession(
  secret: string,
  userId: string,
  nowMs: number = Date.now(),
  issuedAtSeconds?: number,
): Promise<string> {
  if (!secret) throw new Error('Session secret is not configured (set SESSION_SECRET or MOODLE_DB_JWT)');
  if (!UUID.test(userId)) throw new Error('Invalid user id for session');
  const now = Math.floor(nowMs / 1000);
  const iat = issuedAtSeconds !== undefined && Number.isInteger(issuedAtSeconds) && issuedAtSeconds <= now ? issuedAtSeconds : now;
  const payload = `v3.${userId}.${sessionExpiry(now, iat)}.${iat}`;
  return `${payload}.${await hmacHex(secret, payload)}`;
}

export interface VerifiedSession {
  userId: string;
  /** Expiry in epoch seconds, as signed into the token. */
  exp: number;
  /** Original sign-in in epoch seconds (for a legacy v2 token: its expiry minus one period). */
  iat: number;
}

/**
 * Verifies signature and expiry only (no database access, so it can run in middleware).
 * Returns the user id the token was issued for and its expiry, or null when the token is invalid.
 */
export async function verifySessionWithExp(
  secret: string | undefined,
  token: string | undefined,
  nowMs: number = Date.now(),
): Promise<VerifiedSession | null> {
  if (!secret || !token) return null;
  const parts = token.split('.');
  const v3 = parts.length === 5 && parts[0] === 'v3' && /^\d+$/.test(parts[3]);
  // v2 tokens (no issued-at) are still accepted until they expire; their renewal becomes a capped v3.
  const v2 = parts.length === 4 && parts[0] === 'v2';
  if ((!v3 && !v2) || !UUID.test(parts[1]) || !/^\d+$/.test(parts[2])) return null;
  const exp = Number(parts[2]);
  const iat = v3 ? Number(parts[3]) : exp - SESSION_MAX_AGE_SECONDS;
  if (exp * 1000 <= nowMs || (iat + SESSION_ABSOLUTE_MAX_SECONDS) * 1000 <= nowMs) return null;
  const signature = parts[parts.length - 1];
  const expected = await hmacHex(secret, parts.slice(0, -1).join('.'));
  return (await safeEqual(expected, signature)) ? { userId: parts[1], exp, iat } : null;
}

/** Same check as `verifySessionWithExp`, returning only the user id. */
export async function verifySession(
  secret: string | undefined,
  token: string | undefined,
  nowMs: number = Date.now(),
): Promise<string | null> {
  return (await verifySessionWithExp(secret, token, nowMs))?.userId ?? null;
}

/**
 * True when a valid session expires within `SESSION_RENEW_THRESHOLD_SECONDS` and should be re-signed. With the
 * session's `issuedAtSeconds`, false once a renewal could no longer move the expiry (absolute lifetime reached).
 */
export function shouldRenewSession(expSeconds: number, nowMs: number = Date.now(), issuedAtSeconds?: number): boolean {
  if (expSeconds * 1000 - nowMs >= SESSION_RENEW_THRESHOLD_SECONDS * 1000) return false;
  if (issuedAtSeconds === undefined) return true;
  return sessionExpiry(Math.floor(nowMs / 1000), issuedAtSeconds) > expSeconds;
}
