/**
 * True when `value` is a base64url uncompressed P-256 public key (65 bytes starting with 0x04), the only format
 * PushManager.subscribe accepts as applicationServerKey. Inline (no imports) because this file runs before the build.
 */
export function isValidVapidPublicKey(value) {
  const key = (value ?? '').trim();
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(key)) return false;
  const bytes = Buffer.from(key, 'base64url');
  return bytes.length === 65 && bytes[0] === 0x04;
}

// A production deploy with a missing or malformed key would ship a PWA whose push setup silently fails.
if (process.env.VERCEL_ENV === 'production' && !isValidVapidPublicKey(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY)) {
  throw new Error(
    'NEXT_PUBLIC_VAPID_PUBLIC_KEY must be a base64url uncompressed P-256 public key (65 bytes, starts with 0x04) for production builds',
  );
}

/** Headers for every route except /sw.js, which keeps its own stricter entry below. */
const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  experimental: {
    // The schedule import posts a PDF (max 2 MB, checked by the action) through a server action.
    serverActions: { bodySizeLimit: '3mb' },
    // Reuse a dynamic page from the client router cache for 30 s, so switching tabs back and forth is instant.
    staleTimes: { dynamic: 30 },
  },
  async headers() {
    return [
      {
        source: '/((?!sw\\.js).*)',
        headers: securityHeaders,
      },
      {
        // The logo SVGs are large and rarely change: cache them for a day and revalidate in the background.
        source: '/brand/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=86400, stale-while-revalidate=604800' }],
      },
      {
        // The service worker must always be fetched fresh so updates reach installed apps, and it may only load its own scripts.
        source: '/sw.js',
        headers: [
          { key: 'Content-Type', value: 'application/javascript; charset=utf-8' },
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Content-Security-Policy', value: "default-src 'self'; script-src 'self'" },
        ],
      },
    ];
  },
};

export default nextConfig;
