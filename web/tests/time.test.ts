import { describe, expect, it } from 'vitest';
import {
  dateToGuayaquilInput,
  formatGuayaquil,
  formatGuayaquilDue,
  formatGuayaquilShort,
  guayaquilInputToDate,
} from '@/lib/time';

describe('Guayaquil time conversion', () => {
  it('converts local input to UTC (+5h)', () => {
    expect(guayaquilInputToDate('2026-10-07T09:30')?.toISOString()).toBe('2026-10-07T14:30:00.000Z');
  });

  it('rolls over midnight correctly', () => {
    expect(guayaquilInputToDate('2026-12-31T22:00')?.toISOString()).toBe('2027-01-01T03:00:00.000Z');
  });

  it('rejects malformed or impossible values', () => {
    expect(guayaquilInputToDate('')).toBeNull();
    expect(guayaquilInputToDate('2026-02-31T10:00')).toBeNull();
    expect(guayaquilInputToDate('2026-10-07T25:00')).toBeNull();
    expect(guayaquilInputToDate('07/10/2026')).toBeNull();
  });

  it('round-trips input -> date -> input', () => {
    const value = '2026-03-15T00:05';
    expect(dateToGuayaquilInput(guayaquilInputToDate(value)!)).toBe(value);
  });

  it('formats for display independent of server timezone', () => {
    expect(formatGuayaquil('2026-10-07T03:05:00Z')).toBe('06/10/2026 22:05');
    expect(formatGuayaquil(null)).toBe('—');
    expect(formatGuayaquil('not a date')).toBe('—');
  });
});

describe('formatGuayaquilShort', () => {
  it('formats Unix seconds as dd/mm hh:mm in Ecuador time', () => {
    expect(formatGuayaquilShort(Date.parse('2026-10-07T03:05:00Z') / 1000)).toBe('06/10 22:05');
  });

  it('returns a dash for invalid input', () => {
    expect(formatGuayaquilShort(Number.NaN)).toBe('—');
  });
});

describe('formatGuayaquilDue', () => {
  const at = (iso: string) => Date.parse(iso) / 1000;
  const NOW_2026 = at('2026-10-08T12:00:00Z');

  it('shows the weekday, day/month and time in Ecuador time, without the current year', () => {
    // 2026-10-09 04:59 UTC is Thursday 08/10 23:59 in Guayaquil.
    expect(formatGuayaquilDue(at('2026-10-09T04:59:00Z'), NOW_2026)).toBe('jue 08/10 · 23:59');
    expect(formatGuayaquilDue(at('2026-10-07T15:30:00Z'), NOW_2026)).toBe('mié 07/10 · 10:30');
    expect(formatGuayaquilDue(at('2026-10-11T05:00:00Z'), NOW_2026)).toBe('dom 11/10 · 00:00');
    expect(formatGuayaquilDue(at('2026-10-10T14:00:00Z'), NOW_2026)).toBe('sáb 10/10 · 09:00');
  });

  it('adds the year when it is not the current one (in Guayaquil time)', () => {
    expect(formatGuayaquilDue(at('2027-01-05T13:00:00Z'), NOW_2026)).toBe('mar 05/01/2027 · 08:00');
    // 2027-01-01 03:00 UTC is still 31/12/2026 in Guayaquil: same year, no suffix.
    expect(formatGuayaquilDue(at('2027-01-01T03:00:00Z'), NOW_2026)).toBe('jue 31/12 · 22:00');
  });

  it('returns a dash for invalid input', () => {
    expect(formatGuayaquilDue(Number.NaN, NOW_2026)).toBe('—');
    expect(formatGuayaquilDue(Number.POSITIVE_INFINITY, NOW_2026)).toBe('—');
  });
});
