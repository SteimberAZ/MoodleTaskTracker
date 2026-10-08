import { describe, expect, it } from 'vitest';
import { automaticReminderSchedule, describeAutoReminder, parseMilestoneRows } from '@/lib/auto-reminders';

const H = 3600;
const DUE = 1_800_000_000;
const OPEN = { submitted: false, muted: false };
const byKey = (items: ReturnType<typeof automaticReminderSchedule>) => Object.fromEntries(items.map((i) => [i.key, i]));

describe('automaticReminderSchedule', () => {
  it('lists new, 3d, 2d, 1d and 8h in order with their scheduled times', () => {
    const items = automaticReminderSchedule(DUE, DUE - 100 * H, {}, OPEN);
    expect(items.map((i) => i.key)).toEqual(['new', '3d', '2d', '1d', '8h']);
    expect(items.map((i) => i.label)).toEqual([
      'Aviso de tarea nueva',
      '3 días antes',
      '2 días antes',
      '1 día antes',
      '8 horas antes',
    ]);
    expect(items.map((i) => i.at)).toEqual([null, DUE - 72 * H, DUE - 48 * H, DUE - 24 * H, DUE - 8 * H]);
  });

  it('marks future milestones pending and passed ones without record as skipped', () => {
    const s = byKey(automaticReminderSchedule(DUE, DUE - 30 * H, { new: DUE - 90 * H }, OPEN));
    expect(s['3d'].state).toBe('skipped');
    expect(s['2d'].state).toBe('skipped');
    expect(s['1d'].state).toBe('pending');
    expect(s['8h'].state).toBe('pending');
    expect(s.new.state).toBe('sent');
  });

  it('treats the scheduled instant itself as reached (inclusive, like the worker)', () => {
    const at = DUE - 24 * H;
    expect(byKey(automaticReminderSchedule(DUE, at, {}, OPEN))['1d'].state).toBe('skipped');
    expect(byKey(automaticReminderSchedule(DUE, at - 1, {}, OPEN))['1d'].state).toBe('pending');
  });

  it('marks milestones with a record as sent, keeping sent_at', () => {
    const sent = { new: DUE - 90 * H, '3d': DUE - 72 * H + 120, '2d': DUE - 48 * H + 60 };
    const s = byKey(automaticReminderSchedule(DUE, DUE - 30 * H, sent, OPEN));
    expect(s['3d']).toMatchObject({ state: 'sent', sentAt: DUE - 72 * H + 120 });
    expect(s['2d']).toMatchObject({ state: 'sent', sentAt: DUE - 48 * H + 60 });
  });

  it('treats a record without timestamp as sent', () => {
    const s = byKey(automaticReminderSchedule(DUE, DUE - 60 * H, { '3d': null }, OPEN));
    expect(s['3d']).toMatchObject({ state: 'sent', sentAt: null });
  });

  it('reports larger milestones recorded together with a smaller one as not sent', () => {
    // Task first seen with 5h left: 8h fired, and 1d, 2d, 3d were pre-recorded at the same instant.
    const t = DUE - 5 * H;
    const s = byKey(automaticReminderSchedule(DUE, t + 600, { new: t, '8h': t, '1d': t, '2d': t, '3d': t }, OPEN));
    expect(s['8h'].state).toBe('sent');
    expect(s['1d'].state).toBe('skipped');
    expect(s['2d'].state).toBe('skipped');
    expect(s['3d'].state).toBe('skipped');
  });

  it('keeps a milestone sent when it was recorded just before the next window opened', () => {
    const s = byKey(automaticReminderSchedule(DUE, DUE - 40 * H, { '3d': DUE - 48 * H - 1 }, OPEN));
    expect(s['3d'].state).toBe('sent');
    const late = byKey(automaticReminderSchedule(DUE, DUE - 40 * H, { '3d': DUE - 48 * H }, OPEN));
    expect(late['3d'].state).toBe('skipped');
  });

  it('shows stopped for unsent items when the task is submitted', () => {
    const s = byKey(automaticReminderSchedule(DUE, DUE - 30 * H, { new: DUE - 90 * H }, { submitted: true, muted: false }));
    expect(s.new.state).toBe('sent');
    expect(s['3d'].state).toBe('stopped');
    expect(s['1d'].state).toBe('stopped');
    expect(s['8h'].state).toBe('stopped');
  });

  it('shows stopped for unsent items when the task is muted', () => {
    const s = byKey(automaticReminderSchedule(DUE, DUE - 30 * H, {}, { submitted: false, muted: true }));
    expect(s.new.state).toBe('stopped');
    expect(s['2d'].state).toBe('stopped');
  });

  it('returns unknown for every item when milestones could not be read', () => {
    const items = automaticReminderSchedule(DUE, DUE - 30 * H, null, { submitted: true, muted: true });
    expect(items.every((i) => i.state === 'unknown')).toBe(true);
    expect(items[1].at).toBe(DUE - 72 * H);
  });

  it('treats the new item without record as not sent', () => {
    expect(byKey(automaticReminderSchedule(DUE, DUE - 30 * H, {}, OPEN)).new.state).toBe('skipped');
  });

  it('undated tasks only schedule the new-task alert', () => {
    expect(automaticReminderSchedule(0, DUE, {}, OPEN).map((i) => i.key)).toEqual(['new']);
    expect(byKey(automaticReminderSchedule(0, DUE, { new: DUE }, OPEN)).new.state).toBe('sent');
  });
});

describe('describeAutoReminder', () => {
  const s = (sent: Parameters<typeof automaticReminderSchedule>[2], flags = OPEN, now = DUE - 30 * H) =>
    byKey(automaticReminderSchedule(DUE, now, sent, flags));
  const at3d = DUE - 72 * H;

  it('describes each state in Spanish with Ecuador time', () => {
    const short = (ts: number) => {
      const g = new Date((ts - 5 * H) * 1000);
      const p = (n: number) => String(n).padStart(2, '0');
      return `${p(g.getUTCDate())}/${p(g.getUTCMonth() + 1)} ${p(g.getUTCHours())}:${p(g.getUTCMinutes())}`;
    };
    expect(describeAutoReminder(s({ '3d': at3d + 60 })['3d'])).toBe(`Enviado ${short(at3d + 60)}`);
    expect(describeAutoReminder(s({ '3d': null })['3d'])).toBe('Enviado');
    expect(describeAutoReminder(s({})['3d'])).toBe('No enviado');
    expect(describeAutoReminder(s({})['1d'])).toBe(`Programado ${short(DUE - 24 * H)}`);
    expect(describeAutoReminder(s({}, { submitted: true, muted: false })['1d'])).toBe('Detenido');
    expect(describeAutoReminder(s(null)['3d'])).toBe(`Previsto ${short(at3d)}`);
    expect(describeAutoReminder(s(null).new)).toBe('Sin información');
  });
});

describe('parseMilestoneRows', () => {
  it('maps valid rows and ignores malformed ones', () => {
    expect(
      parseMilestoneRows([
        { milestone: 'new', sent_at: 100 },
        { milestone: '3d', sent_at: '200' },
        { milestone: '2d', sent_at: null },
        { milestone: 'weird', sent_at: 1 },
        { milestone: '8h', sent_at: 'abc' },
        null,
        'x',
      ]),
    ).toEqual({ new: 100, '3d': 200, '2d': null, '8h': null });
  });

  it('returns an empty map for non-array input', () => {
    expect(parseMilestoneRows(undefined)).toEqual({});
    expect(parseMilestoneRows({ error: 'x' })).toEqual({});
  });
});
