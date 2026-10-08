import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const session = vi.hoisted(() => ({ requireSessionUserId: vi.fn(), getSessionUserId: vi.fn() }));
const users = vi.hoisted(() => ({ getUserById: vi.fn() }));

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;replace;${to};307;` });
  },
  notFound: () => {
    throw Object.assign(new Error('NEXT_NOT_FOUND'), { digest: 'NEXT_HTTP_ERROR_FALLBACK;404' });
  },
}));
vi.mock('@/lib/session', () => session);
vi.mock('@/lib/users', () => users);

import { withUser } from '@/lib/auth';

const USER_ID = '3f2c8a52-8d5e-4a0b-9f0e-6f3a1c2b4d5e';
const activeUser = { id: USER_ID, username: 'ana', fullname: null, ntfy_topic: 't', is_admin: false, active: true, last_error: null };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  session.requireSessionUserId.mockResolvedValue(USER_ID);
  session.getSessionUserId.mockResolvedValue(USER_ID);
});

describe('withUser', () => {
  it('starts the data load before the user row has been read', async () => {
    const userRow = deferred<typeof activeUser>();
    users.getUserById.mockReturnValue(userRow.promise);
    const load = vi.fn(async (id: string) => `data of ${id}`);

    const result = withUser(load);
    await vi.waitFor(() => expect(load).toHaveBeenCalledWith(USER_ID));
    expect(users.getUserById).toHaveBeenCalledTimes(1);

    userRow.resolve(activeUser);
    await expect(result).resolves.toEqual([activeUser, `data of ${USER_ID}`]);
  });

  it('still redirects an inactive user, and a failing load does not leak an unhandled rejection', async () => {
    users.getUserById.mockResolvedValue({ ...activeUser, active: false });
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const load = vi.fn(() => Promise.reject(new Error('db down')));
      await expect(withUser(load)).rejects.toMatchObject({ digest: expect.stringContaining('/login') });
      expect(load).toHaveBeenCalled();
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('redirects a missing user before returning any data', async () => {
    users.getUserById.mockResolvedValue(null);
    await expect(withUser(async () => 'secret')).rejects.toMatchObject({ digest: expect.stringContaining('/login') });
  });

  it('redirects without loading anything when there is no signed session', async () => {
    session.requireSessionUserId.mockRejectedValue(Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;/login' }));
    const load = vi.fn(async () => 'x');
    await expect(withUser(load)).rejects.toMatchObject({ digest: 'NEXT_REDIRECT;/login' });
    expect(load).not.toHaveBeenCalled();
  });

  it('re-throws the load error once the user is confirmed', async () => {
    users.getUserById.mockResolvedValue(activeUser);
    await expect(withUser(() => Promise.reject(new Error('db down')))).rejects.toThrow('db down');
  });
});
