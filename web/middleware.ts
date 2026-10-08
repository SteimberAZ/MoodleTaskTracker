import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, resolveSessionSecret, verifySession } from '@/lib/session-token';

/**
 * Cheap gate: checks the cookie signature and expiry only (no database access).
 * Whether the user still exists and is active is enforced by `requireUser()` in each page and action.
 */
export async function middleware(request: NextRequest) {
  if (request.nextUrl.pathname === '/login') return NextResponse.next();
  const userId = await verifySession(await resolveSessionSecret(), request.cookies.get(SESSION_COOKIE)?.value);
  if (userId) return NextResponse.next();
  return NextResponse.redirect(new URL('/login', request.url));
}

export const config = {
  // Everything except: the JSON API (each /api handler answers 401 itself instead of redirecting), the service
  // worker, Next static assets, the favicon, the PWA manifest and home-screen icons, the public brand assets
  // and public image files. All of those must load while logged out.
  matcher: [
    '/((?!api/|_next/static|_next/image|favicon.ico|icon.svg|manifest.webmanifest|sw.js|apple-touch-icon.png|icons/|brand/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
