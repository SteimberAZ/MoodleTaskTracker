import { getSessionUserId } from '@/lib/session';
import { loadAvatar } from '@/lib/avatar-store';
import { DEFAULT_AVATAR_SVG, parseAvatarDataUrl } from '@/lib/avatar';

export const dynamic = 'force-dynamic';

function defaultAvatar(cache: string): Response {
  return new Response(DEFAULT_AVATAR_SVG, {
    headers: {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': cache,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    },
  });
}

/**
 * GET /api/avatar?u=<user id>&v=<version>: the session user's photo, or the default one.
 * Only the session decides whose photo is served; a `u` that is not the session user gets the default image and
 * is not cached, so a shared browser never caches one person's photo under another person's URL.
 * The stored image is re-validated (type and signature) before it is served, and never as SVG.
 */
export async function GET(request: Request) {
  const userId = await getSessionUserId();
  const requested = new URL(request.url).searchParams.get('u');
  if (!userId || (requested !== null && requested !== userId)) return defaultAvatar('no-store');

  const photo = parseAvatarDataUrl(await loadAvatar(userId));
  // A versioned URL changes on every upload from this device: cache it for a day. Other devices see the new
  // photo once their own short-lived copy expires.
  const versioned = (new URL(request.url).searchParams.get('v') ?? '0') !== '0';
  const cache = `private, max-age=${versioned ? 86400 : 300}`;
  if (!photo) return defaultAvatar(cache);
  return new Response(photo.bytes, {
    headers: { 'Content-Type': photo.mime, 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' },
  });
}
