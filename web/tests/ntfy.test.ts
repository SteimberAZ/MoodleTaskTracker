import { describe, expect, it } from 'vitest';
import { ntfyEnabledQuery, ntfyEnabledRequest, resolveNtfyEnabled } from '@/lib/ntfy';

const USER = '3f2c8a52-8d5e-4a0b-9f0e-6f3a1c2b4d5e';
const NOW = '2026-10-08T12:00:00.000Z';

describe('ntfy delivery switch', () => {
  it('patches only the session user row', () => {
    const req = ntfyEnabledRequest(USER, false, NOW);
    expect(req.query).toBe(`?id=eq.${USER}&select=id`);
    expect(req.body).toEqual({ ntfy_enabled: false, updated_at: NOW });
    expect(ntfyEnabledRequest(USER, true, NOW).body.ntfy_enabled).toBe(true);
  });

  it('reads the flag of the session user only', () => {
    expect(ntfyEnabledQuery(USER)).toBe(`?id=eq.${USER}&select=ntfy_enabled&limit=1`);
  });

  it('refuses ids that could widen the filter', () => {
    for (const bad of ['', 'abc', `${USER}&id=neq.0`, 'x&id=neq.1']) {
      expect(() => ntfyEnabledRequest(bad, true, NOW)).toThrow();
      expect(() => ntfyEnabledQuery(bad)).toThrow();
    }
  });

  it('defaults to enabled when the column, row or value is missing', () => {
    expect(resolveNtfyEnabled([{ ntfy_enabled: false }])).toBe(false);
    expect(resolveNtfyEnabled([{ ntfy_enabled: true }])).toBe(true);
    expect(resolveNtfyEnabled([{ ntfy_enabled: null }])).toBe(true);
    expect(resolveNtfyEnabled([{}])).toBe(true);
    expect(resolveNtfyEnabled([])).toBe(true);
    expect(resolveNtfyEnabled(undefined)).toBe(true);
    expect(resolveNtfyEnabled(null)).toBe(true);
  });
});
