/**
 * Pure helpers for the Moodle mobile web service (no I/O except via injected fetch).
 * Secrets rule: never log or return the password or the token from here.
 */
export const DEFAULT_MOODLE_URL = 'https://evirtual.utm.edu.ec';
export const MOODLE_TIMEOUT_MS = 15_000;
export const MAX_USERNAME = 100;
export const MAX_PASSWORD = 200;

export function resolveMoodleUrl(raw: string | undefined): string | null {
  try {
    const u = new URL((raw ?? '').trim() || DEFAULT_MOODLE_URL);
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

const TOKEN_ERRORS: Record<string, string> = {
  invalidlogin: 'Usuario o contraseña incorrectos',
  usernamenotfound: 'Usuario o contraseña incorrectos',
  webservicesnotenabled: 'El servicio móvil no está habilitado en este Moodle.',
  servicenotavailable: 'El servicio móvil no está disponible en este Moodle.',
  sitemaintenance: 'Moodle está en mantenimiento. Inténtalo más tarde.',
  usernotconfirmed: 'La cuenta de Moodle no está confirmada.',
  accountsuspended: 'La cuenta de Moodle está suspendida.',
  invalidtoken: 'Moodle rechazó el token. Vuelve a conectar.',
  accessexception: 'Moodle denegó el acceso al servicio móvil.',
};

export const GENERIC_MOODLE_ERROR = 'No se pudo conectar con Moodle. Inténtalo de nuevo.';

export function moodleErrorMessage(code: string | undefined): string {
  if (code && TOKEN_ERRORS[code]) return TOKEN_ERRORS[code];
  return code ? `${GENERIC_MOODLE_ERROR} (${code.slice(0, 40).replace(/[^\w-]/g, '')})` : GENERIC_MOODLE_ERROR;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const errorCodeOf = (v: Record<string, unknown>) => (typeof v.errorcode === 'string' ? v.errorcode : undefined);

/** Parses the `login/token.php` response: `{token}` or `{error, errorcode}`. */
export function parseTokenResponse(body: unknown): Parsed<{ token: string }> {
  if (!isObject(body)) return { ok: false, message: GENERIC_MOODLE_ERROR };
  if (typeof body.token === 'string' && body.token.length > 0) return { ok: true, value: { token: body.token } };
  return { ok: false, message: moodleErrorMessage(errorCodeOf(body)) };
}

export interface SiteInfo {
  userid: number;
  fullname: string;
}

/** Parses `core_webservice_get_site_info`; web-service errors look like `{exception, errorcode, message}`. */
export function parseSiteInfo(body: unknown): Parsed<SiteInfo> {
  if (!isObject(body)) return { ok: false, message: GENERIC_MOODLE_ERROR };
  if (typeof body.exception === 'string' || typeof body.errorcode === 'string') {
    return { ok: false, message: moodleErrorMessage(errorCodeOf(body)) };
  }
  if (typeof body.userid !== 'number' || !Number.isInteger(body.userid)) {
    return { ok: false, message: GENERIC_MOODLE_ERROR };
  }
  return { ok: true, value: { userid: body.userid, fullname: typeof body.fullname === 'string' ? body.fullname : '' } };
}

export interface MoodleConnection {
  token: string;
  siteUserId: number;
  fullname: string;
}

type FetchFn = typeof fetch;

async function postForm(fetchFn: FetchFn, url: string, params: Record<string, string>): Promise<unknown> {
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(MOODLE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Exchanges username/password for a mobile token and verifies it with get_site_info.
 * The password only lives in this call's arguments and request body.
 */
export async function connectToMoodle(
  moodleUrl: string,
  username: string,
  password: string,
  fetchFn: FetchFn = fetch,
): Promise<Parsed<MoodleConnection>> {
  try {
    const tokenResult = parseTokenResponse(
      await postForm(fetchFn, `${moodleUrl}/login/token.php`, { username, password, service: 'moodle_mobile_app' }),
    );
    if (!tokenResult.ok) return tokenResult;
    const { token } = tokenResult.value;

    const info = parseSiteInfo(
      await postForm(fetchFn, `${moodleUrl}/webservice/rest/server.php`, {
        wstoken: token,
        wsfunction: 'core_webservice_get_site_info',
        moodlewsrestformat: 'json',
      }),
    );
    if (!info.ok) return info;
    return { ok: true, value: { token, siteUserId: info.value.userid, fullname: info.value.fullname } };
  } catch {
    // Network error, timeout, redirect or non-JSON body: never include details.
    return { ok: false, message: GENERIC_MOODLE_ERROR };
  }
}

export interface CredentialStatus {
  moodle_url: string;
  username: string;
  fullname: string | null;
  site_userid: number | null;
  connected_at: string;
  last_error: string | null;
  last_error_at: string | null;
}

/** True when the worker recorded an error after the last successful connection. */
export function isDisconnected(c: Pick<CredentialStatus, 'connected_at' | 'last_error' | 'last_error_at'>): boolean {
  if (!c.last_error || !c.last_error_at) return false;
  return new Date(c.last_error_at).getTime() > new Date(c.connected_at).getTime();
}
