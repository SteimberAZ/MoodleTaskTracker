import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const dbFetch = vi.fn();
vi.mock('@/lib/db', () => ({ dbFetch: (...args: unknown[]) => dbFetch(...args) }));

const USER = '3f2c8a52-8d5e-4a0b-9f0e-6f3a1c2b4d5e';
const ROW = {
  id: '7b1f6c1e-3a52-4a52-9d0e-0c5f3a9a1b11',
  kind: 'task',
  title: 't',
  body: null,
  url: null,
  status: 'sent',
  push_ok: 0,
  push_total: 0,
  ntfy_attempted: true,
  ntfy_ok: true,
  created_at: '2026-10-08T12:00:00.000Z',
};

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

beforeEach(() => {
  vi.resetModules();
  dbFetch.mockReset();
});

describe('history reads with push_state', () => {
  it('selects push_state when the column exists', async () => {
    const { listHistoryPage } = await import('@/lib/notification-history');
    dbFetch.mockResolvedValueOnce(json(200, [{ ...ROW, push_state: 'no_devices' }], { 'content-range': '0-0/1' }));
    const page = await listHistoryPage(USER, 'todos', 1);
    expect(page.rows[0].push_state).toBe('no_devices');
    expect(dbFetch).toHaveBeenCalledTimes(1);
    expect(dbFetch.mock.calls[0][0]).toContain(',push_state&');
  });

  it('retries without push_state when the column is missing, and stops asking for it', async () => {
    const { getHistoryEntry, listHistoryPage } = await import('@/lib/notification-history');
    dbFetch
      .mockResolvedValueOnce(json(400, { code: '42703', message: 'column moodle_notification_log.push_state does not exist' }))
      .mockResolvedValueOnce(json(200, [ROW], { 'content-range': '0-0/1' }))
      .mockResolvedValueOnce(json(200, [ROW]));
    const page = await listHistoryPage(USER, 'todos', 1);
    expect(page.rows).toHaveLength(1);
    expect(page.total).toBe(1);
    expect(dbFetch.mock.calls[1][0]).not.toContain('push_state');
    expect(await getHistoryEntry(USER, ROW.id)).toMatchObject({ id: ROW.id });
    expect(dbFetch).toHaveBeenCalledTimes(3);
    expect(dbFetch.mock.calls[2][0]).not.toContain('push_state');
  });

  it('still fails on other errors', async () => {
    const { listHistoryPage } = await import('@/lib/notification-history');
    dbFetch.mockResolvedValueOnce(json(400, { code: '22P02' }));
    await expect(listHistoryPage(USER, 'todos', 1)).rejects.toThrow();
    expect(dbFetch).toHaveBeenCalledTimes(1);
  });
});
