export interface RequestOrigin {
  origin?: string | null;
  secFetchSite?: string | null;
  host?: string | null;
  forwardedHost?: string | null;
}

/**
 * Defense in depth for the cookie-authenticated JSON endpoints (the session cookie is already SameSite=Lax):
 * a browser request that declares itself cross-site, or whose Origin is not this host, is refused.
 * Requests without an Origin header (non-browser clients) rely on the session cookie alone.
 */
export function isSameOriginRequest({ origin, secFetchSite, host, forwardedHost }: RequestOrigin): boolean {
  if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'none') return false;
  if (!origin) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return false; // "null" and other opaque origins
  }
  const allowed = [host, forwardedHost?.split(',')[0]]
    .map((h) => h?.trim().toLowerCase())
    .filter((h): h is string => !!h);
  return allowed.includes(originHost);
}
