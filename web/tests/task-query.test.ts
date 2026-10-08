import { describe, expect, it } from 'vitest';
import {
  LEGACY_COLUMNS,
  TASK_FILTERS,
  countTasksByFilter,
  matchesTaskFilter,
  muteTaskRequest,
  parseTaskFilter,
  taskCountsQuery,
  taskDetailQuery,
  taskMilestonesQuery,
  taskFilterParts,
  taskListQuery,
  type TaskCountRow,
} from '@/lib/task-query';
import { reminderPageQuery } from '@/lib/reminder-query';

const USER = '3f2c8a52-8d5e-4a0b-9f0e-6f3a1c2b4d5e';
const NOW = 1_800_000_000;

describe('parseTaskFilter', () => {
  it('defaults to pendientes', () => {
    expect(parseTaskFilter(undefined)).toBe('pendientes');
    expect(parseTaskFilter('nope')).toBe('pendientes');
    expect(parseTaskFilter('')).toBe('pendientes');
  });

  it('accepts the three tabs', () => {
    expect(parseTaskFilter('silenciadas')).toBe('silenciadas');
    expect(parseTaskFilter('entregadas')).toBe('entregadas');
    expect(parseTaskFilter(['entregadas', 'x'])).toBe('entregadas');
  });
});

describe('taskListQuery', () => {
  it('always starts with the owner filter, for every tab and page', () => {
    for (const { value } of TASK_FILTERS) {
      for (const page of [1, 2, 9]) {
        expect(taskListQuery(USER, value, NOW, page).startsWith(`?user_id=eq.${USER}&`)).toBe(true);
      }
    }
  });

  it('pendientes: not submitted, not muted, not past due, soonest first', () => {
    const q = taskListQuery(USER, 'pendientes', NOW, 1);
    expect(q).toContain('status=neq.submitted');
    expect(q).toContain('is_dismissed=eq.0');
    expect(q).toContain(`due_timestamp=gte.${NOW}`);
    expect(q).toContain('order=due_timestamp.asc');
    expect(q).toContain('limit=8');
    expect(q).toContain('offset=0');
  });

  it('silenciadas and entregadas use their own filters', () => {
    expect(taskFilterParts('silenciadas', NOW)).toEqual(['is_dismissed=eq.1', 'order=due_timestamp.asc']);
    expect(taskFilterParts('entregadas', NOW)).toEqual(['status=eq.submitted', 'order=due_timestamp.desc']);
  });

  it('paginates with limit and offset', () => {
    expect(taskListQuery(USER, 'silenciadas', NOW, 3)).toMatch(/limit=8&offset=16$/);
  });

  it('refuses a malformed user id', () => {
    expect(() => taskListQuery('x&user_id=neq.1', 'pendientes', NOW, 1)).toThrow();
    expect(() => taskCountsQuery('')).toThrow();
  });
});

describe('task detail query', () => {
  it('matches the id AND the owner', () => {
    const q = taskDetailQuery(USER, 'abc123def456');
    expect(q.startsWith(`?user_id=eq.${USER}&id=eq.abc123def456&`)).toBe(true);
    expect(q).toContain('description');
    expect(q).toContain('teachers');
    expect(q.endsWith('limit=1')).toBe(true);
  });

  it('rejects ids that could inject filters', () => {
    expect(() => taskDetailQuery(USER, 'abc&user_id=neq.1')).toThrow();
    expect(() => taskDetailQuery(USER, '')).toThrow();
  });
});

describe('pre-migration fallback', () => {
  it('builds the same owner-scoped queries without the new columns', () => {
    const list = taskListQuery(USER, 'pendientes', NOW, 2, LEGACY_COLUMNS);
    expect(list.startsWith(`?user_id=eq.${USER}&${LEGACY_COLUMNS}&`)).toBe(true);
    expect(list).toMatch(/limit=8&offset=8$/);
    expect(taskDetailQuery(USER, 'abc123def456', LEGACY_COLUMNS)).toBe(
      `?user_id=eq.${USER}&id=eq.abc123def456&${LEGACY_COLUMNS}&limit=1`,
    );
    for (const column of ['module', 'description', 'teachers', 'course_id', 'details_updated_at']) {
      expect(LEGACY_COLUMNS).not.toContain(column);
    }
  });
});

describe('muteTaskRequest', () => {
  it('patches only the owner row and sets is_dismissed to 1 or 0', () => {
    const mute = muteTaskRequest(USER, 'abc123def456', true);
    expect(mute.query).toBe(`?user_id=eq.${USER}&id=eq.abc123def456&select=id`);
    expect(mute.body).toEqual({ is_dismissed: 1 });
    expect(muteTaskRequest(USER, 'abc123def456', false).body).toEqual({ is_dismissed: 0 });
  });

  it('never builds a query without the owner or with an unsafe id', () => {
    expect(() => muteTaskRequest('not-a-uuid', 'abc', true)).toThrow();
    expect(() => muteTaskRequest(USER, 'abc&or=(id.neq.0)', true)).toThrow();
    expect(() => muteTaskRequest(USER, 'a b', true)).toThrow();
  });
});

describe('filter counters', () => {
  const rows: TaskCountRow[] = [
    { status: 'pending', is_dismissed: 0, due_timestamp: NOW + 100 }, // pendiente
    { status: 'pending', is_dismissed: 0, due_timestamp: NOW }, // pendiente (due == now)
    { status: 'pending', is_dismissed: 0, due_timestamp: NOW - 1 }, // vencida: no cuenta
    { status: 'pending', is_dismissed: 1, due_timestamp: NOW + 100 }, // silenciada
    { status: 'submitted', is_dismissed: 0, due_timestamp: NOW - 500 }, // entregada
    { status: 'submitted', is_dismissed: 1, due_timestamp: NOW + 5 }, // entregada y silenciada
    { status: 'pending', is_dismissed: null, due_timestamp: NOW + 5 }, // old row without the flag: pendiente
  ];

  it('counts each tab with the same rules as the query', () => {
    expect(countTasksByFilter(rows, NOW)).toEqual({ pendientes: 3, silenciadas: 2, entregadas: 2 });
  });

  it('matchesTaskFilter mirrors the PostgREST filters', () => {
    expect(matchesTaskFilter(rows[2], 'pendientes', NOW)).toBe(false);
    expect(matchesTaskFilter(rows[3], 'pendientes', NOW)).toBe(false);
    expect(matchesTaskFilter(rows[4], 'pendientes', NOW)).toBe(false);
    expect(matchesTaskFilter(rows[0], 'pendientes', NOW)).toBe(true);
  });
});

describe('reminderPageQuery', () => {
  it('is owner-scoped and paginated', () => {
    expect(reminderPageQuery(USER, 2)).toBe(
      `?user_id=eq.${USER}&select=*&order=active.desc,next_fire_at.asc&limit=8&offset=8`,
    );
    expect(() => reminderPageQuery('bad', 1)).toThrow();
  });
});

describe('taskMilestonesQuery', () => {
  it('filters by an exact task id and selects only what the page needs', () => {
    expect(taskMilestonesQuery('abc123def456')).toBe('?task_id=eq.abc123def456&select=milestone,sent_at');
  });

  it('rejects ids that could inject extra filters', () => {
    expect(() => taskMilestonesQuery('abc&task_id=neq.1')).toThrow();
    expect(() => taskMilestonesQuery('')).toThrow();
  });
});
