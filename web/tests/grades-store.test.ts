import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const dbFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db', () => ({ dbFetch }));

import { loadGrades } from '@/lib/grades-store';

const USER = '3f2c8a52-8d5e-4a0b-9f0e-6f3a1c2b4d5e';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const rowJson = {
  course_id: 10,
  item_id: 501,
  course_name: 'Física',
  item_name: 'Tarea 1',
  item_type: 'mod',
  grade_raw: 17,
  grade_max: 20,
  weight_raw: 0.2,
};

beforeEach(() => {
  dbFetch.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('loadGrades', () => {
  it('returns the parsed rows and queries the session user only', async () => {
    dbFetch.mockResolvedValueOnce(json([rowJson]));
    const result = await loadGrades(USER);
    expect(result).toMatchObject({ state: 'ok', rows: [{ course_id: 10, item_id: 501, grade_raw: 17, weight_raw: 0.2, cmid: null }] });
    expect(String(dbFetch.mock.calls[0][0])).toContain(`user_id=eq.${USER}`);
  });

  it('returns an empty list for an empty body', async () => {
    dbFetch.mockResolvedValueOnce(new Response('', { status: 200 }));
    expect(await loadGrades(USER)).toEqual({ state: 'ok', rows: [] });
  });

  it('reports a missing table on 404 / PGRST205', async () => {
    dbFetch.mockResolvedValueOnce(json({ code: 'PGRST205', message: 'Could not find the table' }, 404));
    expect(await loadGrades(USER)).toEqual({ state: 'missing' });
  });

  it('reports a missing table on 42P01', async () => {
    dbFetch.mockResolvedValueOnce(json({ code: '42P01', message: 'relation does not exist' }, 400));
    expect(await loadGrades(USER)).toEqual({ state: 'missing' });
  });

  it('reports an error on any other status', async () => {
    dbFetch.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    expect(await loadGrades(USER)).toEqual({ state: 'error' });
  });

  it('reports an error when the request rejects', async () => {
    dbFetch.mockRejectedValueOnce(new Error('No se pudo comunicar con la base de datos.'));
    expect(await loadGrades(USER)).toEqual({ state: 'error' });
  });
});
