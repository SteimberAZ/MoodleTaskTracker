import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const dbFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db', () => ({ dbFetch, dbJson: vi.fn(async () => []), dbJsonCounted: vi.fn() }));

import { countTasks, getTaskDetail, listTasksPage } from '@/lib/tasks';
import { getReminderWithTask, listRemindersPage } from '@/lib/reminders';
import { isMissingSinceSupported, resetMissingSinceSupport } from '@/lib/task-query';

const USER = '3f2c8a52-8d5e-4a0b-9f0e-6f3a1c2b4d5e';
const OTHER = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const REMINDER = '0b9c1f2e-3d4a-4b5c-8d6e-7f8091a2b3c4';
const NOW = 1_800_000_000;

const json = (body: unknown, status = 200, range?: string) =>
  new Response(JSON.stringify(body), { status, headers: range ? { 'content-range': range } : {} });
const pgError = (code: string, message: string) => json({ code, message }, 400);
const paths = () => dbFetch.mock.calls.map(([path]) => String(path));

beforeEach(() => {
  dbFetch.mockReset();
  resetMissingSinceSupport();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('missing_since fallback', () => {
  it('retries without the column only when PostgREST rejects it, and remembers that', async () => {
    dbFetch
      .mockResolvedValueOnce(pgError('42703', 'column moodle_tasks.missing_since does not exist'))
      .mockResolvedValueOnce(json([{ id: 'a' }], 200, '0-0/1'))
      .mockResolvedValueOnce(json([], 200, '*/0'));

    const page = await listTasksPage(USER, 'pendientes', 1, NOW);
    expect(page).toMatchObject({ total: 1, page: 1 });
    expect(paths()[0]).toContain('missing_since=is.null');
    expect(paths()[1]).not.toContain('missing_since');
    // Same column set otherwise: no needless legacy fallback.
    expect(paths()[1]).toContain(',module');
    expect(isMissingSinceSupported()).toBe(false);

    await listTasksPage(USER, 'atrasadas', 1, NOW);
    expect(paths()[2]).not.toContain('missing_since');
  });

  it('falls back to the pre-migration columns when another column is missing', async () => {
    dbFetch
      .mockResolvedValueOnce(pgError('42703', 'column moodle_tasks.module does not exist'))
      .mockResolvedValueOnce(json([], 200, '*/0'));
    await listTasksPage(USER, 'pendientes', 1, NOW);
    expect(paths()[1]).not.toContain(',module');
    expect(paths()[1]).toContain('missing_since=is.null');
    expect(isMissingSinceSupported()).toBe(true);
  });

  it('never retries an outage or a timeout', async () => {
    dbFetch.mockResolvedValueOnce(json({ code: 'XX000', message: 'boom' }, 500));
    await expect(listTasksPage(USER, 'pendientes', 1, NOW)).rejects.toThrow('No se pudieron cargar las tareas.');
    dbFetch.mockRejectedValueOnce(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
    await expect(listTasksPage(USER, 'pendientes', 1, NOW)).rejects.toThrow('No se pudieron cargar las tareas.');
    expect(dbFetch).toHaveBeenCalledTimes(2);
    expect(isMissingSinceSupported()).toBe(true);
  });

  it('lets a session redirect through untouched', async () => {
    const redirect = Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;/login' });
    dbFetch.mockRejectedValueOnce(redirect);
    await expect(listTasksPage(USER, 'pendientes', 1, NOW)).rejects.toBe(redirect);
  });

  it('counters are exact counts per tab, never a download of every row', async () => {
    // More rows than PostgREST's max-rows (1000): only the content-range total is used.
    const totals: Record<string, number> = {
      all: 1500,
      pendientes: 4,
      atrasadas: 2,
      sinfecha: 3,
      silenciadas: 1,
      entregadas: 1200,
    };
    dbFetch.mockImplementation(async (path: string, init?: { headers?: Record<string, string> }) => {
      expect(init?.headers?.Prefer).toBe('count=exact');
      const key = path.includes('due_timestamp.eq.0')
        ? 'sinfecha'
        : path.includes('is_dismissed=eq.1')
          ? 'silenciadas'
          : path.includes('status=eq.submitted')
            ? 'entregadas'
            : path.includes('due_timestamp=lt.')
              ? 'atrasadas'
              : path.includes('due_timestamp=gte.')
                ? 'pendientes'
                : 'all';
      return json([{ id: 'x' }], 200, `0-0/${totals[key]}`);
    });
    const counts = await countTasks(USER, NOW);
    expect(counts).toEqual({
      byFilter: { pendientes: 4, atrasadas: 2, sinfecha: 3, silenciadas: 1, entregadas: 1200 },
      total: 1500,
    });
    for (const path of paths()) {
      expect(path).toContain('select=id');
      expect(path).toContain('limit=1');
      expect(path).not.toContain('order=');
    }
    expect(paths().filter((p) => p.includes('missing_since=is.null'))).toHaveLength(3); // ghost rows stay out
  });
});

describe('getTaskDetail', () => {
  it('reads the task and its milestones in one request', async () => {
    dbFetch.mockResolvedValueOnce(
      json([{ id: 'abc123', title: 'T', due_timestamp: NOW, moodle_task_milestones: [{ milestone: '1d', sent_at: 5 }] }]),
    );
    const task = await getTaskDetail(USER, 'abc123');
    expect(dbFetch).toHaveBeenCalledTimes(1);
    expect(paths()[0]).toContain('moodle_task_milestones(milestone,sent_at)');
    expect(task).toMatchObject({ id: 'abc123', milestones: { '1d': 5 } });
    expect(task).not.toHaveProperty('moodle_task_milestones');
  });

  it('falls back to the plain row with milestones null when the embed is rejected', async () => {
    dbFetch
      .mockResolvedValueOnce(pgError('PGRST200', 'Could not find a relationship'))
      .mockResolvedValueOnce(json([{ id: 'abc124', title: 'T', due_timestamp: NOW }]));
    const task = await getTaskDetail(USER, 'abc124');
    expect(paths()[1]).not.toContain('moodle_task_milestones');
    expect(task).toMatchObject({ id: 'abc124', milestones: null });
  });

  it('returns null for malformed ids without a request', async () => {
    await expect(getTaskDetail(USER, 'a&b')).resolves.toBeNull();
    expect(dbFetch).not.toHaveBeenCalled();
  });
});

describe('reminders with their embedded task', () => {
  const reminder = { id: REMINDER, user_id: USER, task_id: 'abc123', active: true };

  it('keeps the task only when it belongs to the owner', async () => {
    dbFetch.mockResolvedValueOnce(
      json(
        [
          { ...reminder, task: { id: 'abc123', title: 'Mine', status: 'submitted', user_id: USER } },
          { ...reminder, id: 'r2', task: { id: 'zzz', title: 'Foreign', status: 'new', user_id: OTHER } },
          { ...reminder, id: 'r3', task_id: 'gone', task: null },
          { ...reminder, id: 'r4', task_id: null, task: null },
        ],
        200,
        '0-3/4',
      ),
    );
    const page = await listRemindersPage(USER, 1);
    expect(dbFetch).toHaveBeenCalledTimes(1);
    expect(page.total).toBe(4);
    expect(page.reminders.map((r) => r.task?.title ?? null)).toEqual(['Mine', null, null, null]);
  });

  it('edit form: one request for the reminder and its task', async () => {
    dbFetch.mockResolvedValueOnce(json([{ ...reminder, task: { id: 'abc123', title: 'Mine', status: 'new', user_id: USER } }]));
    const row = await getReminderWithTask(USER, REMINDER);
    expect(dbFetch).toHaveBeenCalledTimes(1);
    expect(paths()[0]).toContain('task:moodle_tasks(');
    expect(row?.task?.title).toBe('Mine');
  });
});
