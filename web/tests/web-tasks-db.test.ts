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

  it('counters drop ghost rows and report the total of every row', async () => {
    dbFetch.mockResolvedValueOnce(
      json([
        { status: 'pending', is_dismissed: 0, due_timestamp: NOW + 10, missing_since: null },
        { status: 'pending', is_dismissed: 0, due_timestamp: NOW + 10, missing_since: '2026-10-01T00:00:00Z' },
        { status: 'pending', is_dismissed: 0, due_timestamp: NOW - 10, missing_since: null },
      ]),
    );
    const counts = await countTasks(USER, NOW);
    expect(counts).toEqual({ byFilter: { pendientes: 1, atrasadas: 1, silenciadas: 0, entregadas: 0 }, total: 3 });
    expect(paths()[0]).toContain('missing_since');
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
