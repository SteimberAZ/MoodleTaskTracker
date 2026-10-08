// Web Crypto only, so it runs in middleware (edge) and in Node route handlers/actions alike.
export const SESSION_COOKIE = 'moddle_session';
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

const encoder = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(secret: string, message: string): Promise<string> {
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

/** Token format: `v1.<expiresAtSeconds>.<hmacHex>`. */
export async function signSession(secret: string, nowMs: number = Date.now()): Promise<string> {
  if (!secret) throw new Error('SESSION_SECRET is not configured');
  const exp = Math.floor(nowMs / 1000) + SESSION_MAX_AGE_SECONDS;
  const payload = `v1.${exp}`;
  return `${payload}.${await hmacHex(secret, payload)}`;
}

export async function verifySession(
  secret: string | undefined,
  token: string | undefined,
  nowMs: number = Date.now(),
): Promise<boolean> {
  if (!secret || !token) return false;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1' || !/^\d+$/.test(parts[1])) return false;
  if (Number(parts[1]) * 1000 <= nowMs) return false;
  const expected = await hmacHex(secret, `${parts[0]}.${parts[1]}`);
  return safeEqual(expected, parts[2]);
}
