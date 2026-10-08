import { scopedQuery, userFilter } from './queries';

/** Pure helpers for the profile photo (moodle_avatars): validation, queries and the header image URL. */

export const AVATAR_TABLE = 'moodle_avatars';
/** Same bound as the SQL CHECK: a 256px WebP/JPEG is ~15-40 KB, so this leaves room without allowing abuse. */
export const AVATAR_MAX_CHARS = 150_000;
/** Side of the square the browser resizes the photo to before uploading. */
export const AVATAR_SIZE = 256;
/** Version of this device's photo; part of the image URL so a new photo is not hidden by the browser cache. */
export const AVATAR_VERSION_COOKIE = 'avatar_v';
export const AVATAR_ROUTE = '/api/avatar';

export type AvatarMime = 'image/webp' | 'image/jpeg' | 'image/png';

const DATA_URL = /^data:(image\/(?:webp|jpeg|png));base64,([A-Za-z0-9+/]+={0,2})$/;

/** Checks the file signature, so a data URL cannot claim one type and carry another. */
function matchesSignature(mime: AvatarMime, bytes: Uint8Array): boolean {
  const at = (i: number, ...values: number[]) => values.every((v, k) => bytes[i + k] === v);
  if (mime === 'image/png') return at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  if (mime === 'image/jpeg') return at(0, 0xff, 0xd8, 0xff);
  return at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50); // RIFF....WEBP
}

function decodeBase64(text: string): Uint8Array<ArrayBuffer> | null {
  try {
    const binary = atob(text);
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** A validated photo: only WebP, JPEG or PNG within the size bound and with a matching signature. SVG never. */
export function parseAvatarDataUrl(value: unknown): { mime: AvatarMime; bytes: Uint8Array<ArrayBuffer>; dataUrl: string } | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > AVATAR_MAX_CHARS) return null;
  const match = DATA_URL.exec(value);
  if (!match) return null;
  const mime = match[1] as AvatarMime;
  const bytes = decodeBase64(match[2]);
  if (!bytes || bytes.length < 12 || !matchesSignature(mime, bytes)) return null;
  return { mime, bytes, dataUrl: value };
}

export function avatarReadPath(userId: string): string {
  return `${AVATAR_TABLE}${scopedQuery(userId, 'select=image', 'limit=1')}`;
}

export function avatarDeletePath(userId: string): string {
  return `${AVATAR_TABLE}${scopedQuery(userId)}`;
}

export function avatarUpsert(userId: string, dataUrl: string, nowIso: string) {
  userFilter(userId); // throws unless it is a UUID
  return {
    path: `${AVATAR_TABLE}?on_conflict=user_id`,
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: { user_id: userId, image: dataUrl, updated_at: nowIso },
  };
}

/**
 * The header image URL. The user id keeps one browser's cache entries apart when two people use it; the
 * version changes on every upload or removal from this device.
 */
export function avatarSrc(userId: string, version: string | undefined): string {
  const v = version && /^\d{1,15}$/.test(version) ? version : '0';
  return `${AVATAR_ROUTE}?u=${encodeURIComponent(userId)}&v=${v}`;
}

/** Generic person on a neutral circle, shown until the user uploads a photo. Static markup, never user input. */
export const DEFAULT_AVATAR_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
  '<circle cx="32" cy="32" r="32" fill="#d9d2c3"/>' +
  '<circle cx="32" cy="25" r="11" fill="#8a8172"/>' +
  '<path d="M12 54c3-10 11-16 20-16s17 6 20 16a31 31 0 0 1-40 0z" fill="#8a8172"/>' +
  '</svg>';
