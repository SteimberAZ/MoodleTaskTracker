import { describe, expect, it } from 'vitest';
import { detectPlatform, isPlatform } from '@/lib/platform';

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const IPAD =
  'Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';
const ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';

describe('detectPlatform', () => {
  it('detects iOS, Android and desktop', () => {
    expect(detectPlatform(IPHONE)).toBe('ios');
    expect(detectPlatform(IPAD)).toBe('ios');
    expect(detectPlatform(ANDROID)).toBe('android');
    expect(detectPlatform(WINDOWS)).toBe('desktop');
    expect(detectPlatform(MAC)).toBe('desktop');
  });

  it('defaults to desktop without a user agent', () => {
    expect(detectPlatform(null)).toBe('desktop');
    expect(detectPlatform(undefined)).toBe('desktop');
    expect(detectPlatform('')).toBe('desktop');
  });

  it('treats a touch screen on a "Macintosh" user agent as an iPad (iPadOS 13+)', () => {
    expect(detectPlatform(MAC, 5)).toBe('ios');
    expect(detectPlatform(MAC, 0)).toBe('desktop');
    expect(detectPlatform(MAC, 1)).toBe('desktop');
    expect(detectPlatform(WINDOWS, 10)).toBe('desktop');
  });
});

describe('isPlatform', () => {
  it('only accepts the three known values', () => {
    expect(isPlatform('ios')).toBe(true);
    expect(isPlatform('android')).toBe(true);
    expect(isPlatform('desktop')).toBe(true);
    expect(isPlatform('windows')).toBe(false);
    expect(isPlatform(undefined)).toBe(false);
    expect(isPlatform(3)).toBe(false);
  });
});
