import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPathMatch } from 'next/dist/shared/lib/router/utils/path-match';

// A variable specifier keeps tsc from type-checking the plain JS config (allowJs is off).
const CONFIG_PATH = '../next.config.mjs';
const VALID_KEY = 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';

interface HeaderEntry {
  source: string;
  headers: { key: string; value: string }[];
}

async function loadConfig() {
  vi.resetModules();
  return import(/* @vite-ignore */ CONFIG_PATH);
}

/** Headers Next would send for `path`, using its own matcher (later entries override earlier ones). */
function headersFor(entries: HeaderEntry[], path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of entries) {
    if (getPathMatch(entry.source)(path) === false) continue;
    for (const h of entry.headers) out[h.key.toLowerCase()] = h.value;
  }
  return out;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('next.config headers', () => {
  it('sends the security headers on pages and assets, but not on /sw.js', async () => {
    const entries: HeaderEntry[] = await (await loadConfig()).default.headers();
    for (const path of ['/', '/login', '/tareas/abc', '/api/push/status', '/brand/logo.svg', '/manifest.webmanifest']) {
      const h = headersFor(entries, path);
      expect(h['x-frame-options'], path).toBe('DENY');
      expect(h['x-content-type-options'], path).toBe('nosniff');
      expect(h['referrer-policy'], path).toBe('strict-origin-when-cross-origin');
      expect(h['permissions-policy'], path).toBe('camera=(), microphone=(), geolocation=(), payment=()');
      expect(h['content-security-policy'], path).toBe(
        "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
      );
    }
    const sw = headersFor(entries, '/sw.js');
    expect(sw['x-frame-options']).toBeUndefined();
    expect(sw['content-security-policy']).toBe("default-src 'self'; script-src 'self'");
    expect(sw['cache-control']).toBe('no-cache, no-store, must-revalidate');
  });

  it('caches the brand assets and leaves the icons untouched', async () => {
    const entries: HeaderEntry[] = await (await loadConfig()).default.headers();
    expect(headersFor(entries, '/brand/logo.svg')['cache-control']).toBe('public, max-age=86400, stale-while-revalidate=604800');
    expect(headersFor(entries, '/icons/icon-192.png')['cache-control']).toBeUndefined();
  });

  it('keeps dynamic pages in the client router cache for 30 s', async () => {
    const { experimental } = (await loadConfig()).default;
    expect(experimental.staleTimes).toEqual({ dynamic: 30 });
    expect(experimental.serverActions).toEqual({ bodySizeLimit: '3mb' });
  });
});

describe('VAPID public key build guard', () => {
  it('validates the key format', async () => {
    const { isValidVapidPublicKey } = await loadConfig();
    expect(isValidVapidPublicKey(VALID_KEY)).toBe(true);
    expect(isValidVapidPublicKey('')).toBe(false);
    expect(isValidVapidPublicKey(undefined)).toBe(false);
    expect(isValidVapidPublicKey(VALID_KEY.slice(0, -4))).toBe(false);
    expect(isValidVapidPublicKey(`A${VALID_KEY.slice(1)}`)).toBe(false);
    expect(isValidVapidPublicKey(`${VALID_KEY.slice(0, 20)}+/${VALID_KEY.slice(22)}`)).toBe(false);
  });

  it('fails a production build with a missing or malformed key', async () => {
    vi.stubEnv('VERCEL_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', '');
    await expect(loadConfig()).rejects.toThrow(/NEXT_PUBLIC_VAPID_PUBLIC_KEY/);
    vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', 'not-a-key');
    await expect(loadConfig()).rejects.toThrow(/NEXT_PUBLIC_VAPID_PUBLIC_KEY/);
  });

  it('accepts a valid key in production and ignores the key outside production', async () => {
    vi.stubEnv('VERCEL_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', VALID_KEY);
    await expect(loadConfig()).resolves.toBeDefined();
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', '');
    await expect(loadConfig()).resolves.toBeDefined();
  });
});
