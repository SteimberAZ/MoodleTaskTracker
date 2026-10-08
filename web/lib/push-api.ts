import 'server-only';
import { NextResponse } from 'next/server';
import { getCurrentUser } from './auth';
import { detectPlatform, type Platform } from './platform';
import { isSameOriginRequest } from './request-guard';
import type { SessionUser } from './users';

/** Shared plumbing of the `/api/push/*` route handlers. They answer JSON (never redirects) and always no-store. */
const MAX_BODY_BYTES = 8 * 1024;
const MAX_USER_AGENT = 300;

export function jsonResponse(data: Record<string, unknown>, status = 200): NextResponse {
  return NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

export type PushRequest = { ok: true; user: SessionUser; body: unknown } | { ok: false; response: NextResponse };

/**
 * Origin check, session check (JSON 401, no redirect) and a size-limited JSON body, in that order.
 * The middleware does not cover `/api/`, so authentication is enforced here for every handler.
 */
export async function authorizePushRequest(request: Request): Promise<PushRequest> {
  const headers = request.headers;
  if (
    !isSameOriginRequest({
      origin: headers.get('origin'),
      secFetchSite: headers.get('sec-fetch-site'),
      host: headers.get('host'),
      forwardedHost: headers.get('x-forwarded-host'),
    })
  ) {
    return { ok: false, response: jsonResponse({ error: 'Origen no permitido.' }, 403) };
  }

  let user: SessionUser | null;
  try {
    user = await getCurrentUser();
  } catch {
    return { ok: false, response: jsonResponse({ error: 'Servicio no disponible.' }, 503) };
  }
  if (!user) return { ok: false, response: jsonResponse({ error: 'No autorizado.' }, 401) };

  if (!(headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    return { ok: false, response: jsonResponse({ error: 'Se esperaba JSON.' }, 415) };
  }
  const declared = Number(headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) return { ok: false, response: jsonResponse({ error: 'Solicitud demasiado grande.' }, 413) };

  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: false, response: jsonResponse({ error: 'Solicitud inválida.' }, 400) };
  }
  if (text.length > MAX_BODY_BYTES) return { ok: false, response: jsonResponse({ error: 'Solicitud demasiado grande.' }, 413) };
  try {
    return { ok: true, user, body: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, response: jsonResponse({ error: 'JSON inválido.' }, 400) };
  }
}

/** User-Agent (truncated) and the platform to store with a subscription: the browser's hint wins over the UA. */
export function deviceMeta(request: Request, hint?: Platform): { userAgent: string | null; platform: Platform } {
  const ua = request.headers.get('user-agent');
  return { userAgent: ua ? ua.slice(0, MAX_USER_AGENT) : null, platform: hint ?? detectPlatform(ua) };
}
