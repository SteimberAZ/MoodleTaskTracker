import { beforeEach, describe, expect, it } from 'vitest';
import {
  DETAIL_COLUMNS,
  LEGACY_COLUMNS,
  MILESTONES_EMBED,
  OVERDUE_WINDOW_DAYS,
  TASK_FILTERS,
  countTasksByFilter,
  isMissingSinceSupported,
  isUnknownColumnError,
  markMissingSinceUnsupported,
  matchesTaskFilter,
  muteTaskRequest,
  parseTaskFilter,
  resetMissingSinceSupport,
  taskCountsQuery,
  taskDetailQuery,
  taskFilterParts,
  taskListQuery,
  withEmbed,
  type TaskCountRow,
} from '@/lib/task-query';
import { reminderPageQuery } from '@/lib/reminder-query';

beforeEach(() => resetMissingSinceSupport());

const USER = '3f2c8a52-8d5e-4a0b-9f0e-6f3a1c2b4d5e';
const NOW = 1_800_000_000;

describe('parseTaskFilter', () => {
  it('defaults to pendientes', () => {
    expect(parseTaskFilter(undefined)).toBe('pendientes');
    expect(parseTaskFilter('nope')).toBe('pendientes');
    expect(parseTaskFilter('')).toBe('pendientes');
  });

  it('accepts the four tabs', () => {
    expect(parseTaskFilter('atrasadas')).toBe('atrasadas');
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
    expect(q).toContain('missing_since=is.null');
    expect(q).toContain('order=due_timestamp.asc');
    expect(q).toContain('limit=15');
    expect(q).toContain('offset=0');
  });

  it('silenciadas and entregadas use their own filters', () => {
    expect(taskFilterParts('silenciadas', NOW)).toEqual(['is_dismissed=eq.1', 'order=due_timestamp.asc']);
    expect(taskFilterParts('entregadas', NOW)).toEqual(['status=eq.submitted', 'order=due_timestamp.desc']);
  });

  it('paginates with limit and offset', () => {
    expect(taskListQuery(USER, 'silenciadas', NOW, 3)).toMatch(/limit=15&offset=30$/);
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
    expect(list).toMatch(/limit=15&offset=15$/);
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
    { status: 'pending', is_dismissed: 0, due_timestamp: NOW - 1 }, // vencida: cuenta como atrasada
    { status: 'pending', is_dismissed: 1, due_timestamp: NOW + 100 }, // silenciada
    { status: 'submitted', is_dismissed: 0, due_timestamp: NOW - 500 }, // entregada
    { status: 'submitted', is_dismissed: 1, due_timestamp: NOW + 5 }, // entregada y silenciada
    { status: 'pending', is_dismissed: null, due_timestamp: NOW + 5 }, // old row without the flag: pendiente
  ];

  it('counts each tab with the same rules as the query', () => {
    expect(countTasksByFilter(rows, NOW)).toEqual({ pendientes: 3, atrasadas: 1, silenciadas: 2, entregadas: 2 });
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

describe('milestones embed', () => {
  it('joins the milestones into the owner-scoped detail read', () => {
    const q = taskDetailQuery(USER, 'abc123def456', withEmbed(DETAIL_COLUMNS, MILESTONES_EMBED));
    expect(q.startsWith(`?user_id=eq.${USER}&id=eq.abc123def456&`)).toBe(true);
    expect(q).toContain(',moodle_task_milestones(milestone,sent_at)&limit=1');
  });
});

describe('reminder embed', () => {
  it('embeds the linked task without !inner, so count=exact still counts every reminder', () => {
    const q = reminderPageQuery(USER, 1, true);
    expect(q).toBe(
      `?user_id=eq.${USER}&select=*,task:moodle_tasks(id,title,course,due_date_str,due_timestamp,task_url,status,user_id)` +
        '&order=active.desc,next_fire_at.asc&limit=8&offset=0',
    );
    expect(q).not.toContain('!inner');
  });
});

describe('atrasadas tab', () => {
  const WEEK = OVERDUE_WINDOW_DAYS * 24 * 60 * 60;

  it('lists unsubmitted, unmuted tasks due in the last 7 days, most recent first', () => {
    expect(OVERDUE_WINDOW_DAYS).toBe(7);
    expect(taskFilterParts('atrasadas', NOW)).toEqual([
      'status=neq.submitted',
      'is_dismissed=eq.0',
      `due_timestamp=lt.${NOW}`,
      `due_timestamp=gte.${NOW - WEEK}`,
      'missing_since=is.null',
      'order=due_timestamp.desc',
    ]);
    expect(taskListQuery(USER, 'atrasadas', NOW, 1).startsWith(`?user_id=eq.${USER}&`)).toBe(true);
  });

  it('is the second chip', () => {
    expect(TASK_FILTERS.map((f) => f.value)).toEqual(['pendientes', 'atrasadas', 'silenciadas', 'entregadas']);
    expect(TASK_FILTERS[1].label).toBe('Atrasadas');
  });

  it('counts with the same window as the query', () => {
    const base = { status: 'pending', is_dismissed: 0 };
    expect(matchesTaskFilter({ ...base, due_timestamp: NOW - 1 }, 'atrasadas', NOW)).toBe(true);
    expect(matchesTaskFilter({ ...base, due_timestamp: NOW - WEEK }, 'atrasadas', NOW)).toBe(true);
    expect(matchesTaskFilter({ ...base, due_timestamp: NOW - WEEK - 1 }, 'atrasadas', NOW)).toBe(false);
    expect(matchesTaskFilter({ ...base, due_timestamp: NOW }, 'atrasadas', NOW)).toBe(false);
    expect(matchesTaskFilter({ ...base, is_dismissed: 1, due_timestamp: NOW - 5 }, 'atrasadas', NOW)).toBe(false);
    expect(matchesTaskFilter({ status: 'submitted', is_dismissed: 0, due_timestamp: NOW - 5 }, 'atrasadas', NOW)).toBe(
      false,
    );
  });
});

describe('missing_since (ghost tasks)', () => {
  it('hides tasks Moodle no longer returns from pendientes and atrasadas only', () => {
    expect(taskFilterParts('pendientes', NOW)).toContain('missing_since=is.null');
    expect(taskFilterParts('atrasadas', NOW)).toContain('missing_since=is.null');
    expect(taskFilterParts('silenciadas', NOW)).not.toContain('missing_since=is.null');
    expect(taskFilterParts('entregadas', NOW)).not.toContain('missing_since=is.null');
  });

  it('drops them from the in-memory counters too', () => {
    const ghost: TaskCountRow = {
      status: 'pending',
      is_dismissed: 0,
      due_timestamp: NOW + 100,
      missing_since: '2026-10-01T00:00:00Z',
    };
    expect(matchesTaskFilter(ghost, 'pendientes', NOW)).toBe(false);
    expect(matchesTaskFilter({ ...ghost, due_timestamp: NOW - 100 }, 'atrasadas', NOW)).toBe(false);
    // A row read without the column counts as present.
    expect(matchesTaskFilter({ status: 'pending', is_dismissed: 0, due_timestamp: NOW + 1 }, 'pendientes', NOW)).toBe(true);
  });

  it('selects the column for the counters while it is supported', () => {
    expect(taskCountsQuery(USER)).toBe(`?user_id=eq.${USER}&select=status,is_dismissed,due_timestamp,missing_since`);
    expect(taskCountsQuery(USER, { missingSince: false })).toBe(`?user_id=eq.${USER}&select=status,is_dismissed,due_timestamp`);
  });

  it('remembers an unsupported column for the instance lifetime', () => {
    expect(isMissingSinceSupported()).toBe(true);
    markMissingSinceUnsupported();
    expect(isMissingSinceSupported()).toBe(false);
    expect(taskFilterParts('pendientes', NOW)).not.toContain('missing_since=is.null');
    expect(taskCountsQuery(USER)).not.toContain('missing_since');
    // An explicit option still wins over the flag.
    expect(taskFilterParts('pendientes', NOW, { missingSince: true })).toContain('missing_since=is.null');
  });

  it('only treats a PostgREST unknown-column answer as a reason to fall back', () => {
    expect(isUnknownColumnError(400, '42703')).toBe(true);
    expect(isUnknownColumnError(400, 'PGRST204')).toBe(true);
    expect(isUnknownColumnError(400, 'PGRST200')).toBe(false);
    expect(isUnknownColumnError(500, '42703')).toBe(false);
    expect(isUnknownColumnError(0, null)).toBe(false);
  });
});
