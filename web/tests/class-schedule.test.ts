import { describe, expect, it } from 'vitest';
import {
  CLASS_LEAD_OPTIONS,
  SAMPLE_CLASS,
  classNotification,
  classReminderQuery,
  classReminderRequest,
  groupByWeekday,
  guayaquilWeekday,
  leadLabel,
  parseClassLead,
  pickSampleClass,
  resolveClassLead,
  rowToClass,
  sanitizeClasses,
  sanitizePeriodEnd,
  scheduleDeleteAllQuery,
  scheduleDeleteExceptQuery,
  scheduleInsertRows,
  scheduleListQuery,
  titleCase,
  type ClassScheduleRow,
} from '@/lib/class-schedule';
import type { ScheduleClass } from '@/lib/sga-schedule';

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ROW_ID = '33333333-3333-4333-8333-333333333333';

const cls = (over: Partial<ScheduleClass> = {}): ScheduleClass => ({
  subject: 'DESARROLLO DE APLICACIONES WEB',
  level: 5,
  parallel: 'A',
  credits: 4,
  teacher: 'NOMBRE FICTICIO',
  department: null,
  weekday: 2,
  startTime: '07:00',
  endTime: '09:00',
  place: 'FACULTAD DE CIENCIAS INFORMÁTICAS',
  roomCode: '1-59-1-03-LC',
  roomType: 'LABORATORIO DE COMPUTACION',
  floor: '1',
  ...over,
});

describe('titleCase (same rules as the worker)', () => {
  it('keeps small words lowercase and acronyms upper-case', () => {
    expect(titleCase('INTRODUCCIÓN A LA INVESTIGACIÓN CIENTÍFICA (EMI)')).toBe('Introducción a la Investigación Científica (EMI)');
    expect(titleCase('TÉCNICAS DE SIMULACIÓN')).toBe('Técnicas de Simulación');
  });

  it('capitalizes the first word even when it is a small word', () => {
    expect(titleCase('DE LA TIERRA Y EL MAR')).toBe('De la Tierra y El Mar');
    expect(titleCase('A LOS PIES')).toBe('A los Pies');
  });

  it('keeps roman numerals and hyphenated words', () => {
    expect(titleCase('PROGRAMACIÓN II')).toBe('Programación II');
    expect(titleCase('ANÁLISIS-DISEÑO DE SISTEMAS')).toBe('Análisis-Diseño de Sistemas');
  });

  it('handles empty values', () => {
    expect(titleCase(null)).toBe('');
    expect(titleCase('   ')).toBe('');
  });
});

describe('leadLabel', () => {
  it('formats minutes and hours', () => {
    expect(leadLabel(30)).toBe('30 min');
    expect(leadLabel(60)).toBe('1 hora');
    expect(leadLabel(180)).toBe('3 horas');
  });
});

describe('classNotification', () => {
  it('builds the title and body the worker sends', () => {
    const n = classNotification(cls(), 30);
    expect(n.title).toBe('📚 Clase en 30 min: Desarrollo de Aplicaciones Web (A)');
    expect(n.body).toBe(['🕘 07:00–09:00', '📍 Laboratorio de Computacion 1-59-1-03-LC, piso 1', '👨‍🏫 Nombre Ficticio'].join('\n'));
  });

  it('uses the lead label in the title', () => {
    expect(classNotification(cls(), 60).title).toContain('Clase en 1 hora:');
    expect(classNotification(cls(), 180).title).toContain('Clase en 3 horas:');
  });

  it('leaves out missing parts and falls back to the place', () => {
    const n = classNotification(cls({ parallel: null, teacher: null, roomCode: null, roomType: null, floor: null }), 30);
    expect(n.title).toBe('📚 Clase en 30 min: Desarrollo de Aplicaciones Web');
    expect(n.body).toBe(['🕘 07:00–09:00', '📍 Facultad de Ciencias Informáticas'].join('\n'));
  });

  it('works for the made-up sample used when there is no schedule', () => {
    expect(classNotification(SAMPLE_CLASS, 30).title).toBe('📚 Clase en 30 min: Programación Orientada a Objetos (A)');
  });
});

describe('lead time validation', () => {
  it('accepts only the four options', () => {
    expect(parseClassLead('off')).toEqual({ ok: true, minutes: null });
    expect(parseClassLead('30')).toEqual({ ok: true, minutes: 30 });
    expect(parseClassLead('60')).toEqual({ ok: true, minutes: 60 });
    expect(parseClassLead('180')).toEqual({ ok: true, minutes: 180 });
    for (const bad of ['', '0', '45', '-30', '30.5', ' 30', '1e2', 'null', null, undefined, 30, {}]) {
      expect(parseClassLead(bad)).toEqual({ ok: false });
    }
    expect(CLASS_LEAD_OPTIONS.map((o) => o.value)).toEqual([null, 30, 60, 180]);
  });

  it('reads the saved value, treating anything unknown as off', () => {
    expect(resolveClassLead([{ class_reminder_minutes: 60 }])).toBe(60);
    expect(resolveClassLead([{ class_reminder_minutes: null }])).toBeNull();
    expect(resolveClassLead([{ class_reminder_minutes: 45 }])).toBeNull();
    expect(resolveClassLead([])).toBeNull();
    expect(resolveClassLead(undefined)).toBeNull();
  });

  it('builds a PATCH scoped to the session user and refuses other values', () => {
    expect(classReminderQuery(ME)).toBe(`?id=eq.${ME}&select=class_reminder_minutes&limit=1`);
    const req = classReminderRequest(ME, 30, '2026-10-08T00:00:00.000Z');
    expect(req.query).toBe(`?id=eq.${ME}&select=id`);
    expect(req.body).toEqual({ class_reminder_minutes: 30, updated_at: '2026-10-08T00:00:00.000Z' });
    expect(classReminderRequest(ME, null, 'x').body.class_reminder_minutes).toBeNull();
    expect(() => classReminderRequest(ME, 45, 'x')).toThrow();
    expect(() => classReminderRequest('not-a-uuid', 30, 'x')).toThrow();
  });
});

describe('day grouping and the sample class', () => {
  it('groups Lunes to Domingo, sorts by start time and skips empty days', () => {
    const groups = groupByWeekday([
      cls({ weekday: 4, startTime: '16:00' }),
      cls({ weekday: 2, startTime: '09:00' }),
      cls({ weekday: 2, startTime: '07:00' }),
      cls({ weekday: 7, startTime: '08:00' }),
    ]);
    expect(groups.map((g) => g.name)).toEqual(['Martes', 'Jueves', 'Domingo']);
    expect(groups[0].items.map((i) => i.startTime)).toEqual(['07:00', '09:00']);
  });

  it('computes the weekday in Ecuador time (UTC-5)', () => {
    expect(guayaquilWeekday(new Date('2026-10-05T12:00:00Z'))).toBe(1); // Monday
    expect(guayaquilWeekday(new Date('2026-10-05T03:00:00Z'))).toBe(7); // Sunday 22:00 in Ecuador
    expect(guayaquilWeekday(new Date('2026-10-11T12:00:00Z'))).toBe(7);
  });

  it('picks the next class to start, wrapping around the week', () => {
    const classes = [cls({ weekday: 2, startTime: '07:00' }), cls({ weekday: 4, startTime: '16:00', subject: 'OTRA' })];
    // Tuesday 2026-10-06 08:00 in Ecuador: the next one is Thursday 16:00.
    expect(pickSampleClass(classes, new Date('2026-10-06T13:00:00Z'))?.subject).toBe('OTRA');
    // Friday: wraps to next Tuesday.
    expect(pickSampleClass(classes, new Date('2026-10-09T13:00:00Z'))?.weekday).toBe(2);
    expect(pickSampleClass([], new Date())).toBeNull();
  });
});

describe('sanitizeClasses', () => {
  it('keeps valid entries and drops invalid ones', () => {
    const out = sanitizeClasses([
      cls(),
      cls({ weekday: 8 }),
      cls({ startTime: '09:00', endTime: '07:00' }),
      cls({ startTime: '7:00' }),
      cls({ subject: '   ' }),
      null,
      'texto',
      { subject: 'X', weekday: '2', startTime: '07:00', endTime: '08:00' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].subject).toBe('DESARROLLO DE APLICACIONES WEB');
  });

  it('bounds text, numbers and the number of entries', () => {
    const [long] = sanitizeClasses([cls({ subject: 'A'.repeat(500), level: 1000, credits: -1, teacher: ' \n ' })]);
    expect(long.subject).toHaveLength(200);
    expect(long.level).toBeNull();
    expect(long.credits).toBeNull();
    expect(long.teacher).toBeNull();
    expect(sanitizeClasses(Array.from({ length: 300 }, () => cls()))).toHaveLength(100);
    expect(sanitizeClasses('nope')).toEqual([]);
  });

  it('only accepts real calendar dates as the period end', () => {
    expect(sanitizePeriodEnd('2027-01-31')).toBe('2027-01-31');
    expect(sanitizePeriodEnd('2027-02-30')).toBeNull();
    expect(sanitizePeriodEnd('31/01/2027')).toBeNull();
    expect(sanitizePeriodEnd(20270131)).toBeNull();
  });
});

describe('save scoping builders', () => {
  it('lists only the session user rows', () => {
    expect(scheduleListQuery(ME)).toBe(`?user_id=eq.${ME}&select=*&order=weekday.asc,start_time.asc`);
    expect(() => scheduleListQuery('1 or 1=1')).toThrow();
  });

  it('inserts rows with uniform keys and the session user id', () => {
    const rows = scheduleInsertRows(ME, [cls(), cls({ teacher: null, roomCode: null, place: null, floor: null, roomType: null })], {
      label: 'SEPTIEMBRE 2026 - ENERO 2027 (PREGRADO)',
      end: '2027-01-31',
    });
    expect(rows).toHaveLength(2);
    const keys = Object.keys(rows[0]).sort();
    expect(Object.keys(rows[1]).sort()).toEqual(keys);
    expect(keys).toEqual(
      [
        'credits',
        'department',
        'end_time',
        'floor',
        'level',
        'parallel',
        'period_end',
        'period_label',
        'place',
        'room_code',
        'room_type',
        'start_time',
        'subject',
        'teacher',
        'user_id',
        'weekday',
      ].sort(),
    );
    expect(rows.every((r) => r.user_id === ME && r.period_end === '2027-01-31')).toBe(true);
    expect(rows[0]).toMatchObject({ start_time: '07:00', end_time: '09:00', room_code: '1-59-1-03-LC', weekday: 2 });
  });

  it('never takes the owner from the entries', () => {
    const tampered = { ...cls(), user_id: OTHER } as ScheduleClass;
    expect(scheduleInsertRows(ME, [tampered], { label: null, end: null })[0].user_id).toBe(ME);
    expect(() => scheduleInsertRows('nope', [cls()], { label: null, end: null })).toThrow();
  });

  it('deletes are always scoped by user_id', () => {
    expect(scheduleDeleteAllQuery(ME)).toBe(`?user_id=eq.${ME}`);
    expect(scheduleDeleteExceptQuery(ME, [ROW_ID, OTHER])).toBe(`?user_id=eq.${ME}&id=not.in.(${ROW_ID},${OTHER})`);
    expect(scheduleDeleteExceptQuery(ME, [])).toBe(`?user_id=eq.${ME}`);
    expect(() => scheduleDeleteExceptQuery(ME, ['1)&user_id=neq.x'])).toThrow();
    expect(() => scheduleDeleteAllQuery('')).toThrow();
  });

  it('maps a database row back to a class (times come as HH:MM:SS)', () => {
    const row: ClassScheduleRow = {
      id: ROW_ID,
      user_id: ME,
      subject: 'MATERIA',
      level: 5,
      parallel: 'A',
      credits: 3,
      teacher: null,
      department: null,
      weekday: 3,
      start_time: '07:00:00',
      end_time: '09:00:00',
      place: null,
      room_code: 'X-1',
      room_type: 'AULA',
      floor: '2',
      period_label: null,
      period_end: null,
      created_at: '2026-10-08T00:00:00Z',
    };
    expect(rowToClass(row)).toMatchObject({ subject: 'MATERIA', weekday: 3, startTime: '07:00', endTime: '09:00', roomCode: 'X-1' });
  });
});
