import { describe, expect, it } from 'vitest';
import { checkCooldown } from '@/lib/rate-limit';

describe('checkCooldown', () => {
  it('blocks repeated calls inside the window and reports the wait', () => {
    const calls = new Map<string, number>();
    expect(checkCooldown(calls, 'u1', 1_000, 30_000)).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(checkCooldown(calls, 'u1', 11_000, 30_000)).toEqual({ allowed: false, retryAfterSeconds: 20 });
    expect(checkCooldown(calls, 'u1', 31_000, 30_000).allowed).toBe(true);
  });

  it('tracks users independently', () => {
    const calls = new Map<string, number>();
    checkCooldown(calls, 'u1', 0, 30_000);
    expect(checkCooldown(calls, 'u2', 1, 30_000).allowed).toBe(true);
  });
});
