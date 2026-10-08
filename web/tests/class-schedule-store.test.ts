import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ dbFetch: vi.fn(), dbJson: vi.fn() }));

import { dbFetch, dbJson } from '@/lib/db';
import { replaceClassSchedule } from '@/lib/class-schedule-store';
import type { ScheduleClass } from '@/lib/sga-schedule';

const USER = '11111111-1111-4111-8111-111111111111';
const NEW_ID = '22222222-2222-4222-8222-222222222222';
const PERIOD = { label: '2026-2', end: '2027-01-31' };
const CLASS: ScheduleClass = {
  subject: 'CÁLCULO',
  level: 1,
  parallel: 'A',
  credits: 4,
  teacher: null,
  department: null,
  weekday: 1,
  startTime: '07:00',
  endTime: '09:00',
  place: null,
  roomCode: null,
  roomType: null,
  floor: null,
};

const fetchMock = vi.mocked(dbFetch);
const jsonMock = vi.mocked(dbJson);
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  fetchMock.mockReset();
  jsonMock.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('replaceClassSchedule', () => {
  it('uses the atomic RPC when the database has it, in one request', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(replaceClassSchedule(USER, [CLASS], PERIOD)).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe('rpc/moodle_replace_class_schedule');
    expect(init?.method).toBe('POST');
    const body = JSON.parse(String(init?.body));
    expect(body.p_user_id).toBe(USER);
    expect(body.p_rows).toHaveLength(1);
    expect(body.p_rows[0]).toMatchObject({ user_id: USER, subject: 'CÁLCULO', start_time: '07:00', period_end: '2027-01-31' });
    expect(jsonMock).not.toHaveBeenCalled();
  });

  it('reports an RPC failure without falling back (a retry converges)', async () => {
    fetchMock.mockResolvedValueOnce(json(500, { code: 'XX000' }));

    await expect(replaceClassSchedule(USER, [CLASS], PERIOD)).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(jsonMock).not.toHaveBeenCalled();
  });

  it.each([
    ['HTTP 404', json(404, { code: 'PGRST202', message: 'Could not find the function' })],
    ['PGRST202 with another status', json(400, { code: 'PGRST202' })],
  ])('falls back to insert-then-delete when the function is missing (%s)', async (_name, missing) => {
    fetchMock.mockResolvedValueOnce(missing).mockResolvedValueOnce(new Response(null, { status: 204 }));
    jsonMock.mockResolvedValueOnce([{ id: NEW_ID }]);

    await expect(replaceClassSchedule(USER, [CLASS], PERIOD)).resolves.toBe(true);

    expect(jsonMock).toHaveBeenCalledTimes(1);
    const [insertPath, insertInit] = jsonMock.mock.calls[0];
    expect(insertPath).toBe('moodle_class_schedule?select=id');
    expect(insertInit?.method).toBe('POST');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [deletePath, deleteInit] = fetchMock.mock.calls[1];
    expect(deleteInit?.method).toBe('DELETE');
    expect(deletePath).toContain(`user_id=eq.${USER}`);
    expect(deletePath).toContain(`id=not.in.(${NEW_ID})`);
  });

  it('fails the fallback when the insert returned fewer rows, without deleting anything', async () => {
    fetchMock.mockResolvedValueOnce(json(404, {}));
    jsonMock.mockResolvedValueOnce([]);

    await expect(replaceClassSchedule(USER, [CLASS], PERIOD)).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns false when the request throws', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network'));
    await expect(replaceClassSchedule(USER, [CLASS], PERIOD)).resolves.toBe(false);
  });
});
