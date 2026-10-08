export type Platform = 'ios' | 'android' | 'desktop';

export const PLATFORMS: readonly Platform[] = ['ios', 'android', 'desktop'];

export function isPlatform(value: unknown): value is Platform {
  return typeof value === 'string' && (PLATFORMS as readonly string[]).includes(value);
}

/**
 * Coarse platform from the User-Agent. `maxTouchPoints` is only available in the browser: iPadOS 13+
 * sends a desktop (Macintosh) UA, and a touch screen on a "Macintosh" is an iPad.
 */
export function detectPlatform(userAgent: string | null | undefined, maxTouchPoints = 0): Platform {
  const ua = userAgent ?? '';
  if (/android/i.test(ua)) return 'android';
  if (/iphone|ipad|ipod/i.test(ua)) return 'ios';
  if (/macintosh/i.test(ua) && maxTouchPoints > 1) return 'ios';
  return 'desktop';
}
