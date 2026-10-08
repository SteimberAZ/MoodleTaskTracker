import { describe, expect, it } from 'vitest';
import { MAX_SCHEDULE_ENTRIES, scheduleInsertRows } from '@/lib/class-schedule';
import { FIELD_LIMITS, parseScheduleEntries, validateEntryFields } from '@/lib/schedule-entries';
import type { ScheduleClass } from '@/lib/sga-schedule';

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

const cls = (over: Partial<ScheduleClass> = {}): ScheduleClass => ({
  subject: 'MATERIA FICTICIA',
  level: 5,
  parallel: 'A',
  credits: 3,
  teacher: 'NOMBRE FICTICIO',
  department: null,
  weekday: 2,
  startTime: '07:00',
  endTime: '09:00',
  place: 'FACULTAD FICTICIA',
  roomCode: '1-59-1-03-LC',
  roomType: 'LABORATORIO',
  floor: '1',
  ...over,
});

describe('validateEntryFields', () => {
  it('accepts a complete entry and one with only the required fields', () => {
    expect(validateEntryFields({ ...cls() })).toEqual({});
    expect(validateEntryFields({ subject: 'X', weekday: 1, startTime: '07:00', endTime: '07:01' })).toEqual({});
  });

  it('requires the subject, even if it is only whitespace', () => {
    expect(validateEntryFields({ ...cls({ subject: '  \n ' }) }).subject).toBeTruthy();
    expect(validateEntryFields({ ...cls(), subject: undefined }).subject).toBeTruthy();
  });

  it('checks weekday is an integer from 1 to 7', () => {
    for (const bad of [0, 8, 1.5, '2', null, NaN]) expect(validateEntryFields({ ...cls(), weekday: bad }).weekday).toBeTruthy();
    for (const ok of [1, 4, 7]) expect(validateEntryFields({ ...cls({ weekday: ok }) }).weekday).toBeUndefined();
  });

  it('checks HH:MM times and that the end is after the start', () => {
    for (const bad of ['', '7:00', '24:00', '12:60', '07:00:00', 'ab:cd']) {
      expect(validateEntryFields({ ...cls({ startTime: bad }) }).startTime).toBeTruthy();
      expect(validateEntryFields({ ...cls({ endTime: bad }) }).endTime).toBeTruthy();
    }
    expect(validateEntryFields({ ...cls({ startTime: '09:00', endTime: '09:00' }) }).endTime).toMatch(/posterior/);
    expect(validateEntryFields({ ...cls({ startTime: '10:00', endTime: '09:00' }) }).endTime).toMatch(/posterior/);
    expect(validateEntryFields({ ...cls({ startTime: '00:00', endTime: '23:59' }) })).toEqual({});
  });

  it('bounds text lengths after collapsing whitespace', () => {
    expect(validateEntryFields({ ...cls({ subject: 'A'.repeat(200) }) }).subject).toBeUndefined();
    expect(validateEntryFields({ ...cls({ subject: 'A'.repeat(201) }) }).subject).toMatch(/200/);
    expect(validateEntryFields({ ...cls({ teacher: 'B'.repeat(201) }) }).teacher).toBeTruthy();
    expect(validateEntryFields({ ...cls({ place: 'C'.repeat(201) }) }).place).toBeTruthy();
    expect(validateEntryFields({ ...cls({ subject: `A${' '.repeat(50)}B` }) }).subject).toBeUndefined();
    for (const field of Object.keys(FIELD_LIMITS) as (keyof typeof FIELD_LIMITS)[]) {
      expect(validateEntryFields({ ...cls(), [field]: 'x'.repeat(FIELD_LIMITS[field] + 1) })[field]).toBeTruthy();
    }
  });

  it('rejects non-string text values', () => {
    expect(validateEntryFields({ ...cls(), teacher: 5 }).teacher).toBeTruthy();
    expect(validateEntryFields({ ...cls(), floor: {} }).floor).toBeTruthy();
  });
});

describe('parseScheduleEntries', () => {
  it('returns normalised classes for valid input', () => {
    const out = parseScheduleEntries([cls({ subject: '  MATERIA   FICTICIA ', teacher: null })]);
    expect(out).toEqual({ ok: true, classes: [cls({ teacher: null })] });
  });

  it('rejects non-arrays, empty lists and more than 60 entries', () => {
    for (const bad of [null, undefined, 'x', {}, 7]) expect(parseScheduleEntries(bad).ok).toBe(false);
    expect(parseScheduleEntries([]).ok).toBe(false);
    expect(parseScheduleEntries(Array.from({ length: MAX_SCHEDULE_ENTRIES }, () => cls())).ok).toBe(true);
    const tooMany = parseScheduleEntries(Array.from({ length: MAX_SCHEDULE_ENTRIES + 1 }, () => cls()));
    expect(tooMany).toEqual({ ok: false, error: expect.stringContaining('60') });
  });

  it('is strict: one bad entry rejects everything and names it', () => {
    const out = parseScheduleEntries([cls(), cls({ weekday: 9 })]);
    expect(out).toEqual({ ok: false, error: expect.stringMatching(/^Clase 2: /) });
    for (const bad of [null, 'texto', 3, [cls()]]) expect(parseScheduleEntries([cls(), bad]).ok).toBe(false);
    expect(parseScheduleEntries([cls({ subject: 'A'.repeat(201) })]).ok).toBe(false);
    expect(parseScheduleEntries([cls({ startTime: '10:00', endTime: '09:00' })]).ok).toBe(false);
    expect(parseScheduleEntries([cls({ startTime: '7:00' })]).ok).toBe(false);
  });
});

describe('server payload for edited entries', () => {
  const period = { label: 'SEPTIEMBRE 2026 - ENERO 2027', end: '2027-01-31' };

  it('takes user_id from the session and ignores any user_id the browser sent', () => {
    const forged = { ...cls(), user_id: OTHER, id: 'x', period_end: '1999-01-01' };
    const parsed = parseScheduleEntries([forged]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const rows = scheduleInsertRows(ME, parsed.classes, period);
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(ME);
    expect(rows[0].period_end).toBe('2027-01-31');
    expect(rows[0]).not.toHaveProperty('id');
  });

  it('gives every row exactly the same keys, whatever optional fields were left empty', () => {
    const parsed = parseScheduleEntries([cls(), cls({ teacher: null, parallel: null, place: null, roomCode: null, roomType: null, floor: null })]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const [a, b] = scheduleInsertRows(ME, parsed.classes, period);
    expect(Object.keys(a)).toEqual(Object.keys(b));
  });

  it('refuses a session user id that is not a uuid', () => {
    expect(() => scheduleInsertRows('1 or 1=1', [cls()], period)).toThrow();
  });
});
