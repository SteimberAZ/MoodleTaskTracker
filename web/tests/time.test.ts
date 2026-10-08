import { describe, expect, it } from 'vitest';
import { dateToGuayaquilInput, formatGuayaquil, formatGuayaquilShort, guayaquilInputToDate } from '@/lib/time';

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
