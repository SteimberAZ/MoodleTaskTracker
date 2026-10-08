import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/session', () => ({ requireSessionUserId: vi.fn(async () => 'user-1') }));

import { DB_FAILURE, DB_TIMEOUT_MS, dbFetch, dbFetchAnonymous, dbJson } from '@/lib/db';

const ENV = { SUPABASE_URL: 'https://db.example.com', SUPABASE_ANON_KEY: 'anon', MOODLE_DB_JWT: 'jwt' };

describe('db request timeout', () => {
  beforeEach(() => {
    for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('attaches a timeout signal when the caller passes none', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response('[]'));
    vi.stubGlobal('fetch', fetchMock);
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    await dbFetchAnonymous('moodle_users?select=id');
    expect(timeout).toHaveBeenCalledWith(DB_TIMEOUT_MS);
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('keeps a caller-provided signal', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response('[]'));
    vi.stubGlobal('fetch', fetchMock);
    const own = new AbortController().signal;
    await dbFetch('moodle_users?select=id', { signal: own });
    expect(fetchMock.mock.calls[0][1].signal).toBe(own);
  });

  it('rejects an aborted fetch with the friendly error and logs the error name only', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('The operation was aborted due to timeout https://db.example.com', 'TimeoutError');
      }),
    );
    await expect(dbFetch('moodle_tasks?select=id')).rejects.toThrow(DB_FAILURE);
    expect(console.error).toHaveBeenCalledWith('Supabase request failed', 'TimeoutError');
  });

  it('maps an AbortError through dbJson to the same friendly error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('aborted', 'AbortError');
      }),
    );
    await expect(dbJson('moodle_tasks?select=id')).rejects.toThrow(DB_FAILURE);
    expect(console.error).toHaveBeenCalledWith('Supabase request failed', 'AbortError');
  });
});
