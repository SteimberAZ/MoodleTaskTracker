import { NextResponse, type NextRequest } from 'next/server';
import {
  SESSION_COOKIE,
  SESSION_COOKIE_OPTIONS,
  resolveSessionSecret,
  shouldRenewSession,
  signSession,
  verifySessionWithExp,
} from '@/lib/session-token';

/**
 * Cheap gate: checks the cookie signature and expiry only (no database access).
 * Whether the user still exists and is active is enforced by `requireUser()` in each page and action.
 * A valid session in its last week is re-signed for another full period (rolling session), so people who
 * keep using the app are never logged out.
 */
export async function middleware(request: NextRequest) {
  if (request.nextUrl.pathname === '/login') return NextResponse.next();
  const secret = await resolveSessionSecret();
  const session = await verifySessionWithExp(secret, request.cookies.get(SESSION_COOKIE)?.value);
  if (session) {
    const response = NextResponse.next();
    if (secret && shouldRenewSession(session.exp)) {
      response.cookies.set(SESSION_COOKIE, await signSession(secret, session.userId), SESSION_COOKIE_OPTIONS);
    }
    return response;
  }
  // Remember where the user was going, so the login returns there (validated again by safeNext on use).
  const login = new URL('/login', request.url);
  const { pathname, search } = request.nextUrl;
  if (pathname !== '/') login.searchParams.set('next', `${pathname}${search}`);
  return NextResponse.redirect(login);
}

export const config = {
  // Everything except: the JSON API (each /api handler answers 401 itself instead of redirecting), the service
  // worker, Next static assets, the favicon, the PWA manifest and home-screen icons, the public brand assets
  // and public image files. All of those must load while logged out.
  matcher: [
    '/((?!api/|_next/static|_next/image|favicon.ico|icon.svg|manifest.webmanifest|sw.js|apple-touch-icon.png|icons/|brand/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
