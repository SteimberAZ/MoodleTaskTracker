import { describe, expect, it } from 'vitest';
import {
  FIRST_SYNC_WINDOW_MS,
  groupTasksByDay,
  guayaquilDay,
  isAwaitingFirstSync,
  taskGroupKey,
} from '@/lib/task-groups';

const at = (iso: string) => Date.parse(iso) / 1000;

// Wednesday 2026-10-07, 20:00 in Guayaquil (01:00 UTC on Thursday).
const NOW = at('2026-10-08T01:00:00Z');

describe('guayaquilDay', () => {
  it('changes day at midnight Guayaquil time (05:00 UTC), not at midnight UTC', () => {
    expect(guayaquilDay(at('2026-10-08T04:59:59Z'))).toBe(guayaquilDay(at('2026-10-07T05:00:00Z')));
    expect(guayaquilDay(at('2026-10-08T05:00:00Z'))).toBe(guayaquilDay(at('2026-10-07T05:00:00Z')) + 1);
  });
});

describe('taskGroupKey', () => {
  it('keeps a deadline after midnight UTC but before local midnight in "Hoy"', () => {
    expect(taskGroupKey(at('2026-10-08T04:59:00Z'), NOW)).toBe('hoy'); // Wed 23:59 local
    expect(taskGroupKey(at('2026-10-08T05:00:00Z'), NOW)).toBe('manana'); // Thu 00:00 local
    expect(taskGroupKey(at('2026-10-09T04:59:00Z'), NOW)).toBe('manana'); // Thu 23:59 local
  });

  it('"Esta semana" runs until Sunday, then "Más adelante"', () => {
    expect(taskGroupKey(at('2026-10-09T05:00:00Z'), NOW)).toBe('semana'); // Fri
    expect(taskGroupKey(at('2026-10-12T04:59:00Z'), NOW)).toBe('semana'); // Sun 23:59
    expect(taskGroupKey(at('2026-10-12T05:00:00Z'), NOW)).toBe('despues'); // Mon 00:00
  });

  it('on a Sunday evening, Monday is "Mañana" and the rest is later', () => {
    const sunday = at('2026-10-12T02:00:00Z'); // Sun 11/10 21:00 local
    expect(taskGroupKey(at('2026-10-12T04:00:00Z'), sunday)).toBe('hoy');
    expect(taskGroupKey(at('2026-10-12T15:00:00Z'), sunday)).toBe('manana');
    expect(taskGroupKey(at('2026-10-13T15:00:00Z'), sunday)).toBe('despues');
  });

  it('a past deadline still counts as today', () => {
    expect(taskGroupKey(NOW - 3600, NOW)).toBe('hoy');
  });
});

describe('groupTasksByDay', () => {
  it('keeps the list order inside each group and skips empty groups', () => {
    const tasks = [
      { id: 'a', due_timestamp: at('2026-10-08T03:00:00Z') },
      { id: 'b', due_timestamp: at('2026-10-08T04:00:00Z') },
      { id: 'c', due_timestamp: at('2026-10-20T15:00:00Z') },
    ];
    const groups = groupTasksByDay(tasks, NOW);
    expect(groups.map((g) => [g.label, g.items.map((t) => t.id)])).toEqual([
      ['Hoy', ['a', 'b']],
      ['Más adelante', ['c']],
    ]);
  });

  it('returns no groups for an empty page', () => {
    expect(groupTasksByDay([], NOW)).toEqual([]);
  });
});

describe('isAwaitingFirstSync', () => {
  const nowMs = Date.parse('2026-10-08T12:00:00Z');
  const ago = (ms: number) => new Date(nowMs - ms).toISOString();

  it('a new account with no tasks yet is syncing for 3 minutes', () => {
    const base = { createdAt: ago(60_000), lastLoginAt: ago(60_000), totalTasks: 0 };
    expect(isAwaitingFirstSync(base, nowMs)).toBe(true);
    expect(isAwaitingFirstSync({ ...base, createdAt: ago(FIRST_SYNC_WINDOW_MS + 1), lastLoginAt: ago(FIRST_SYNC_WINDOW_MS + 1) }, nowMs)).toBe(false);
    expect(isAwaitingFirstSync({ ...base, totalTasks: 4 }, nowMs)).toBe(false);
  });

  it('uses last_synced_at when the column exists: never synced or synced before the last login', () => {
    const login = ago(2 * 60_000);
    expect(isAwaitingFirstSync({ createdAt: ago(9e9), lastLoginAt: login, lastSyncedAt: null, totalTasks: 3 }, nowMs)).toBe(true);
    expect(isAwaitingFirstSync({ createdAt: ago(9e9), lastLoginAt: login, lastSyncedAt: ago(9e6), totalTasks: 3 }, nowMs)).toBe(true);
    expect(isAwaitingFirstSync({ createdAt: ago(9e9), lastLoginAt: login, lastSyncedAt: ago(30_000), totalTasks: 3 }, nowMs)).toBe(false);
  });

  it('stops promising a sync long after the login (worker late or failing)', () => {
    expect(isAwaitingFirstSync({ createdAt: ago(9e9), lastLoginAt: ago(60 * 60_000), lastSyncedAt: null, totalTasks: 0 }, nowMs)).toBe(false);
  });

  it('without the column (or without data) only the new-account rule applies', () => {
    expect(isAwaitingFirstSync({ createdAt: ago(9e9), lastLoginAt: ago(5 * 60_000), totalTasks: 2 }, nowMs)).toBe(false);
    expect(isAwaitingFirstSync({ createdAt: null, lastLoginAt: null, totalTasks: null }, nowMs)).toBe(false);
  });
});
