import { describe, expect, it } from 'vitest';
import { MAX_SCHEDULE_ENTRIES } from '@/lib/class-schedule';
import {
  blankEntry,
  classToEntry,
  classesToEntries,
  editorReducer,
  entriesToClasses,
  entryToClass,
  isDirty,
  pdfFileProblem,
  validateEditor,
  type EditorEntry,
} from '@/lib/schedule-editor';
import type { ScheduleClass } from '@/lib/sga-schedule';

const cls = (over: Partial<ScheduleClass> = {}): ScheduleClass => ({
  subject: 'MATERIA FICTICIA',
  level: 5,
  parallel: 'A',
  credits: 3,
  teacher: 'NOMBRE FICTICIO',
  department: 'DEPTO FICTICIO',
  weekday: 2,
  startTime: '07:00',
  endTime: '09:00',
  place: 'FACULTAD FICTICIA',
  roomCode: '1-59-1-03-LC',
  roomType: 'LABORATORIO',
  floor: '1',
  ...over,
});

const valid = (key: string, over: Partial<EditorEntry> = {}): EditorEntry => ({ ...classToEntry(cls(), key), ...over });

describe('editor reducer', () => {
  it('adds a blank entry at the end with the given key', () => {
    const next = editorReducer([valid('a')], { type: 'add', key: 'n1' });
    expect(next.map((e) => e.key)).toEqual(['a', 'n1']);
    expect(next[1]).toEqual(blankEntry('n1'));
    expect(next[1].subject).toBe('');
  });

  it('ignores add when full or when the key already exists', () => {
    const full = Array.from({ length: MAX_SCHEDULE_ENTRIES }, (_, i) => valid(`k${i}`));
    expect(editorReducer(full, { type: 'add', key: 'n1' })).toBe(full);
    const one = [valid('a')];
    expect(editorReducer(one, { type: 'add', key: 'a' })).toBe(one);
  });

  it('removes by key and leaves the state alone for an unknown key', () => {
    const state = [valid('a'), valid('b')];
    expect(editorReducer(state, { type: 'remove', key: 'a' }).map((e) => e.key)).toEqual(['b']);
    expect(editorReducer(state, { type: 'remove', key: 'zzz' })).toBe(state);
  });

  it('updates only the editable fields of the targeted entry', () => {
    const state = [valid('a'), valid('b')];
    const next = editorReducer(state, {
      type: 'update',
      key: 'b',
      patch: { subject: 'OTRA', weekday: 5, key: 'hijack', level: 99 } as never,
    });
    expect(next[0]).toBe(state[0]);
    expect(next[1].subject).toBe('OTRA');
    expect(next[1].weekday).toBe(5);
    expect(next[1].key).toBe('b');
    expect(next[1].level).toBe(5);
    expect(editorReducer(state, { type: 'update', key: 'zzz', patch: { subject: 'X' } })).toBe(state);
  });

  it('resets to the given entries', () => {
    const entries = [valid('x')];
    expect(editorReducer([valid('a'), valid('b')], { type: 'reset', entries })).toBe(entries);
  });
});

describe('conversions', () => {
  it('round-trips a class and turns empty text into null', () => {
    const c = cls();
    expect(entryToClass(classToEntry(c, 'a'))).toEqual(c);
    const blank = entryToClass(valid('a', { teacher: '   ', place: '', parallel: ' ', floor: '' }));
    expect(blank).toMatchObject({ teacher: null, place: null, parallel: null, floor: null });
  });

  it('collapses whitespace and keeps the non-editable PDF fields', () => {
    const out = entryToClass(valid('a', { subject: '  MATERIA \n  FICTICIA ' }));
    expect(out.subject).toBe('MATERIA FICTICIA');
    expect(out.level).toBe(5);
    expect(out.credits).toBe(3);
    expect(out.department).toBe('DEPTO FICTICIO');
  });

  it('builds unique keys for a list', () => {
    const entries = classesToEntries([cls(), cls()]);
    expect(new Set(entries.map((e) => e.key)).size).toBe(2);
    expect(entriesToClasses(entries)).toEqual([cls(), cls()]);
  });

  it('detects changes against the starting entries, ignoring keys', () => {
    const initial = classesToEntries([cls()]);
    expect(isDirty(classesToEntries([cls()], 'z'), initial)).toBe(false);
    expect(isDirty(editorReducer(initial, { type: 'update', key: 'k0', patch: { floor: '2' } }), initial)).toBe(true);
    expect(isDirty([], initial)).toBe(true);
  });
});

describe('validateEditor', () => {
  it('is valid for good entries', () => {
    const result = validateEditor(classesToEntries([cls(), cls({ weekday: 4 })]));
    expect(result).toEqual({ byKey: {}, listError: null, valid: true });
  });

  it('reports errors per entry key', () => {
    const entries = [valid('a'), valid('b', { startTime: '10:00', endTime: '09:00' }), valid('c', { subject: '' })];
    const result = validateEditor(entries);
    expect(result.valid).toBe(false);
    expect(Object.keys(result.byKey)).toEqual(['b', 'c']);
    expect(result.byKey.b.endTime).toBeTruthy();
    expect(result.byKey.c.subject).toBeTruthy();
  });

  it('flags blank new entries (no times, no subject)', () => {
    const result = validateEditor([blankEntry('n1')]);
    expect(Object.keys(result.byKey.n1).sort()).toEqual(['endTime', 'startTime', 'subject']);
  });

  it('requires at least one and at most 60 entries', () => {
    expect(validateEditor([])).toMatchObject({ valid: false, listError: expect.stringContaining('al menos') });
    const many = Array.from({ length: MAX_SCHEDULE_ENTRIES + 1 }, (_, i) => valid(`k${i}`));
    expect(validateEditor(many)).toMatchObject({ valid: false, listError: expect.stringContaining('60') });
  });

  it('rejects over-long text', () => {
    expect(validateEditor([valid('a', { place: 'x'.repeat(201) })]).byKey.a.place).toBeTruthy();
  });
});

describe('pdfFileProblem', () => {
  it('accepts a PDF up to 2 MB', () => {
    expect(pdfFileProblem({ name: 'horario.pdf', size: 1000, type: 'application/pdf' })).toBeNull();
    expect(pdfFileProblem({ name: 'horario.PDF', size: 1000, type: '' })).toBeNull();
    expect(pdfFileProblem({ name: 'a.pdf', size: 2 * 1024 * 1024, type: 'application/pdf' })).toBeNull();
  });

  it('rejects empty, oversized and non-PDF files', () => {
    expect(pdfFileProblem({ name: 'a.pdf', size: 0, type: 'application/pdf' })).toBeTruthy();
    expect(pdfFileProblem({ name: 'a.pdf', size: 2 * 1024 * 1024 + 1, type: 'application/pdf' })).toMatch(/2 MB/);
    expect(pdfFileProblem({ name: 'a.png', size: 10, type: 'image/png' })).toBeTruthy();
    expect(pdfFileProblem({ name: 'a.txt', size: 10, type: '' })).toBeTruthy();
  });
});
