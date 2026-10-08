/** Longest return path kept; anything longer is not a link this app produced. */
export const MAX_NEXT_LENGTH = 2048;

const PROBE_ORIGIN = 'http://x';
const CONTROL = /[\u0000-\u001f\u007f]/;

function decodedOrNull(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/**
 * Return target after a (re-)login. Accepts only a same-origin relative path: it must start with a single '/',
 * contain no backslash or control character (also when percent-decoded) and still resolve to this origin.
 * The login page itself is never a target (it would loop). Anything else falls back to '/'.
 */
export function safeNext(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_NEXT_LENGTH) return '/';
  const decoded = decodedOrNull(raw);
  if (decoded === null) return '/';
  for (const candidate of [raw, decoded]) {
    if (!candidate.startsWith('/') || candidate.startsWith('//')) return '/';
    if (candidate.includes('\\') || CONTROL.test(candidate)) return '/';
  }
  let url: URL;
  try {
    url = new URL(raw, PROBE_ORIGIN);
  } catch {
    return '/';
  }
  if (url.origin !== PROBE_ORIGIN) return '/';
  if (url.pathname === '/login' || url.pathname.startsWith('/login/')) return '/';
  return raw;
}
