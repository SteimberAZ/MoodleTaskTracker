/** Pure random-string generators (Web Crypto only, so they run on any runtime). */
export const TOPIC_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
export const TOPIC_PREFIX = 'utm-';
export const TOPIC_RANDOM_LENGTH = 20;

/** No 0/O/1/I so codes are easy to read aloud and type. */
export const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const INVITE_CODE_LENGTH = 10;

export type RandomFill = (bytes: Uint8Array) => Uint8Array;

const defaultFill: RandomFill = (bytes) => crypto.getRandomValues(bytes);

/**
 * Uniform random string over `alphabet`. Uses rejection sampling so alphabets whose size
 * does not divide 256 stay unbiased.
 */
export function randomString(alphabet: string, length: number, fill: RandomFill = defaultFill): string {
  if (alphabet.length < 2 || alphabet.length > 256) throw new Error('Invalid alphabet size');
  const limit = 256 - (256 % alphabet.length);
  let out = '';
  while (out.length < length) {
    const bytes = fill(new Uint8Array(length * 2));
    for (let i = 0; i < bytes.length && out.length < length; i++) {
      if (bytes[i] < limit) out += alphabet[bytes[i] % alphabet.length];
    }
  }
  return out;
}

/** `utm-` + 20 lowercase base32 characters (100 bits): unguessable, valid as an ntfy topic. */
export function generateNtfyTopic(fill: RandomFill = defaultFill): string {
  return TOPIC_PREFIX + randomString(TOPIC_ALPHABET, TOPIC_RANDOM_LENGTH, fill);
}

export function generateInviteCode(fill: RandomFill = defaultFill): string {
  return randomString(INVITE_ALPHABET, INVITE_CODE_LENGTH, fill);
}

const TOPIC_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** ntfy topics accept letters, digits, `_` and `-` (max 64 chars). */
export function isValidTopic(topic: string): boolean {
  return TOPIC_PATTERN.test(topic);
}

const INVITE_PATTERN = /^[A-Z0-9]{1,32}$/;

/** Normalizes what a person typed: trims, drops spaces/dashes, uppercases. Null when it cannot be a code. */
export function normalizeInviteCode(raw: string): string | null {
  const code = raw.replace(/[\s-]+/g, '').toUpperCase();
  return INVITE_PATTERN.test(code) ? code : null;
}

export const DEFAULT_NTFY_SERVER = 'https://ntfy.sh';

/** Base URL of the ntfy server: `NTFY_SERVER` when it is a valid https URL, otherwise ntfy.sh. */
export function resolveNtfyServer(raw: string | undefined): string {
  try {
    const u = new URL((raw ?? '').trim() || DEFAULT_NTFY_SERVER);
    if (u.protocol !== 'https:' || u.username || u.password) return DEFAULT_NTFY_SERVER;
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return DEFAULT_NTFY_SERVER;
  }
}
