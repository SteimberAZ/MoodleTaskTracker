import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, verifySession } from '@/lib/session-token';

/**
 * Cheap gate: checks the cookie signature and expiry only (no database access).
 * Whether the user still exists and is active is enforced by `requireUser()` in each page and action.
 */
export async function middleware(request: NextRequest) {
  if (request.nextUrl.pathname === '/login') return NextResponse.next();
  const userId = await verifySession(process.env.SESSION_SECRET, request.cookies.get(SESSION_COOKIE)?.value);
  if (userId) return NextResponse.next();
  return NextResponse.redirect(new URL('/login', request.url));
}

export const config = {
  // Everything except Next static assets, the favicon and public image files (logo on the login page).
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)'],
};
