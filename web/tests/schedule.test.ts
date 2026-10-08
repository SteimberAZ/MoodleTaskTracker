import { describe, expect, it } from 'vitest';
import { computeNextFire, formatInterval, reminderStatus, splitInterval, toIntervalMinutes } from '@/lib/schedule';

const d = (iso: string) => new Date(iso);

describe('computeNextFire', () => {
  const startsAt = d('2026-10-10T12:00:00Z');
  const endsAt = d('2026-10-11T12:00:00Z');

  it('uses startsAt while it is in the future', () => {
    const r = computeNextFire({ startsAt, endsAt, intervalMinutes: 60, now: d('2026-10-09T00:00:00Z') });
    expect(r.nextFireAt.toISOString()).toBe('2026-10-10T12:00:00.000Z');
    expect(r.active).toBe(true);
  });

  it('aligns to the next whole interval after now', () => {
    const r = computeNextFire({ startsAt, endsAt, intervalMinutes: 60, now: d('2026-10-10T14:20:00Z') });
    expect(r.nextFireAt.toISOString()).toBe('2026-10-10T15:00:00.000Z');
    expect(r.active).toBe(true);
  });

  it('moves strictly past now when now is exactly on a boundary', () => {
    const r = computeNextFire({ startsAt, endsAt, intervalMinutes: 60, now: d('2026-10-10T14:00:00Z') });
    expect(r.nextFireAt.toISOString()).toBe('2026-10-10T15:00:00.000Z');
  });

  it('deactivates when the next fire is past endsAt', () => {
    const r = computeNextFire({ startsAt, endsAt, intervalMinutes: 60, now: d('2026-10-11T11:30:00Z') });
    expect(r.nextFireAt.toISOString()).toBe('2026-10-11T12:00:00.000Z');
    expect(r.active).toBe(true);
    const late = computeNextFire({ startsAt, endsAt, intervalMinutes: 60, now: d('2026-10-11T12:30:00Z') });
    expect(late.active).toBe(false);
  });
});

describe('interval helpers', () => {
  it('converts units to minutes', () => {
    expect(toIntervalMinutes(2, 'hours')).toBe(120);
    expect(toIntervalMinutes(3, 'days')).toBe(4320);
    expect(toIntervalMinutes(30, 'minutes')).toBe(30);
  });

  it('splits minutes into the largest even unit', () => {
    expect(splitInterval(1440)).toEqual({ amount: 1, unit: 'days' });
    expect(splitInterval(120)).toEqual({ amount: 2, unit: 'hours' });
    expect(splitInterval(90)).toEqual({ amount: 90, unit: 'minutes' });
  });

  it('formats Spanish frequency text', () => {
    expect(formatInterval(30)).toBe('cada 30 minutos');
    expect(formatInterval(60)).toBe('cada hora');
    expect(formatInterval(120)).toBe('cada 2 horas');
    expect(formatInterval(1440)).toBe('cada día');
    expect(formatInterval(2880)).toBe('cada 2 días');
  });
});

describe('reminderStatus', () => {
  const now = d('2026-10-10T00:00:00Z');
  it('reports finalizado, pausado and activo', () => {
    expect(reminderStatus({ active: true, ends_at: '2026-10-09T00:00:00Z' }, now)).toBe('finalizado');
    expect(reminderStatus({ active: false, ends_at: '2026-10-11T00:00:00Z' }, now)).toBe('pausado');
    expect(reminderStatus({ active: true, ends_at: '2026-10-11T00:00:00Z' }, now)).toBe('activo');
  });
});
