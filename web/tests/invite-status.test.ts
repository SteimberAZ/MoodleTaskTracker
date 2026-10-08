import { describe, expect, it } from 'vitest';
import { inviteStatus, inviteStatusLabel, parseExpiryDays } from '@/lib/invite-status';

const NOW = new Date('2026-10-07T12:00:00Z');
const base = { expires_at: null, used_at: null, used_by: null };

describe('inviteStatus', () => {
  it('is available without expiry or before it', () => {
    expect(inviteStatus(base, NOW)).toEqual({ kind: 'disponible' });
    expect(inviteStatus({ ...base, expires_at: '2026-10-08T00:00:00Z' }, NOW)).toEqual({ kind: 'disponible' });
  });

  it('is expired at or after the expiry instant', () => {
    expect(inviteStatus({ ...base, expires_at: '2026-10-07T12:00:00Z' }, NOW)).toEqual({ kind: 'vencida' });
    expect(inviteStatus({ ...base, expires_at: '2026-10-01T00:00:00Z' }, NOW)).toEqual({ kind: 'vencida' });
  });

  it('is used once used_at is set, even if it also expired', () => {
    expect(
      inviteStatus({ expires_at: '2026-10-01T00:00:00Z', used_at: '2026-09-30T00:00:00Z', used_by: 'u1' }, NOW),
    ).toEqual({ kind: 'usada', usedBy: 'u1' });
  });
});

describe('inviteStatusLabel', () => {
  it('names who used it when known', () => {
    const names = new Map([['u1', 'Ana Perez']]);
    expect(inviteStatusLabel({ kind: 'usada', usedBy: 'u1' }, (id) => names.get(id))).toBe('usada por Ana Perez');
    expect(inviteStatusLabel({ kind: 'usada', usedBy: 'gone' }, (id) => names.get(id))).toBe('usada');
    expect(inviteStatusLabel({ kind: 'usada', usedBy: null }, () => undefined)).toBe('usada');
    expect(inviteStatusLabel({ kind: 'disponible' }, () => undefined)).toBe('disponible');
    expect(inviteStatusLabel({ kind: 'vencida' }, () => undefined)).toBe('vencida');
  });
});

describe('parseExpiryDays', () => {
  it('treats blank as no expiry and bounds the days', () => {
    expect(parseExpiryDays('')).toBeNull();
    expect(parseExpiryDays('  ')).toBeNull();
    expect(parseExpiryDays('7')).toBe(7);
    expect(parseExpiryDays('365')).toBe(365);
    expect(parseExpiryDays('0')).toBeUndefined();
    expect(parseExpiryDays('366')).toBeUndefined();
    expect(parseExpiryDays('-1')).toBeUndefined();
    expect(parseExpiryDays('1.5')).toBeUndefined();
    expect(parseExpiryDays('abc')).toBeUndefined();
  });
});
