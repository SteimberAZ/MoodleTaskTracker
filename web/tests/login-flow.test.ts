import { describe, expect, it, vi } from 'vitest';
import {
  ERR_ADMIN_TOPIC,
  ERR_CREATE,
  ERR_INACTIVE,
  ERR_INVITE,
  ERR_NEEDS_INVITE,
  decideLogin,
  isBootstrapAdminName,
  type CreateUserResult,
  type LoginDeps,
  type LoginRequest,
  type LoginUser,
} from '@/lib/login-flow';

const NOW = new Date('2026-10-07T12:00:00.000Z');
const URL = 'https://evirtual.utm.edu.ec';

const request = (over: Partial<LoginRequest> = {}): LoginRequest => ({
  moodleUrl: URL,
  connection: { token: 'tok-1', siteUserId: 42, fullname: 'Ana Perez' },
  username: 'aperez',
  inviteCode: '',
  ...over,
});

const user = (over: Partial<LoginUser> = {}): LoginUser => ({ id: 'u-1', is_admin: false, active: true, ...over });

function makeDeps(over: Partial<LoginDeps> = {}): LoginDeps {
  return {
    now: () => NOW,
    randomTopic: () => 'utm-random-topic',
    findUser: vi.fn(async () => null),
    adminExists: vi.fn(async () => false),
    createUser: vi.fn(async (): Promise<CreateUserResult> => ({ kind: 'created', user: user({ id: 'new-1' }) })),
    updateLogin: vi.fn(async () => {}),
    claimInvite: vi.fn(async () => true),
    releaseInvite: vi.fn(async () => {}),
    markInviteUsed: vi.fn(async () => {}),
    claimOrphanReminders: vi.fn(async () => {}),
    ...over,
  };
}

describe('existing user', () => {
  it('refreshes token and clears errors without needing an invite', async () => {
    const deps = makeDeps({ findUser: vi.fn(async () => user()) });
    const out = await decideLogin(deps, request());
    expect(out).toEqual({ ok: true, userId: 'u-1', created: false, isAdmin: false });
    expect(deps.updateLogin).toHaveBeenCalledWith('u-1', {
      token: 'tok-1',
      fullname: 'Ana Perez',
      username: 'aperez',
      nowIso: NOW.toISOString(),
    });
    expect(deps.claimInvite).not.toHaveBeenCalled();
    expect(deps.createUser).not.toHaveBeenCalled();
  });

  it('ignores an invite code supplied by an existing user (it is not consumed)', async () => {
    const deps = makeDeps({ findUser: vi.fn(async () => user()) });
    const out = await decideLogin(deps, request({ inviteCode: 'ABCDEFGH23' }));
    expect(out.ok).toBe(true);
    expect(deps.claimInvite).not.toHaveBeenCalled();
  });

  it('does not overwrite the stored name with an empty one', async () => {
    const deps = makeDeps({ findUser: vi.fn(async () => user()) });
    await decideLogin(deps, request({ connection: { token: 't', siteUserId: 42, fullname: '' } }));
    expect(vi.mocked(deps.updateLogin).mock.calls[0][1].fullname).toBeUndefined();
  });

  it('rejects an inactive user without touching their token', async () => {
    const deps = makeDeps({ findUser: vi.fn(async () => user({ active: false })) });
    expect(await decideLogin(deps, request())).toEqual({ ok: false, error: ERR_INACTIVE });
    expect(deps.updateLogin).not.toHaveBeenCalled();
  });

  it('lets the bootstrap admin re-claim orphan reminders on login', async () => {
    const deps = makeDeps({ findUser: vi.fn(async () => user({ is_admin: true })) });
    const out = await decideLogin(deps, request({ adminUsername: 'APerez ' }));
    expect(out).toMatchObject({ ok: true, isAdmin: true });
    expect(deps.claimOrphanReminders).toHaveBeenCalledWith('u-1');
  });

  it('does not claim orphans for a non-admin or an admin who is not the configured one', async () => {
    const deps = makeDeps({ findUser: vi.fn(async () => user({ is_admin: true })) });
    await decideLogin(deps, request({ adminUsername: 'someone-else' }));
    expect(deps.claimOrphanReminders).not.toHaveBeenCalled();
  });
});

describe('admin bootstrap', () => {
  it('creates the admin without an invite, keeps the configured topic and claims orphans', async () => {
    const deps = makeDeps({
      createUser: vi.fn(async (): Promise<CreateUserResult> => ({ kind: 'created', user: user({ id: 'adm', is_admin: true }) })),
    });
    const out = await decideLogin(deps, request({ adminUsername: 'APEREZ', adminTopic: ' my-existing_topic ' }));
    expect(out).toEqual({ ok: true, userId: 'adm', created: true, isAdmin: true });
    expect(deps.createUser).toHaveBeenCalledWith(
      expect.objectContaining({ is_admin: true, ntfy_topic: 'my-existing_topic', site_userid: 42, token: 'tok-1' }),
    );
    expect(deps.claimOrphanReminders).toHaveBeenCalledWith('adm');
    expect(deps.claimInvite).not.toHaveBeenCalled();
  });

  it('uses a random topic when none is configured', async () => {
    const deps = makeDeps();
    await decideLogin(deps, request({ adminUsername: 'aperez' }));
    expect(deps.createUser).toHaveBeenCalledWith(expect.objectContaining({ ntfy_topic: 'utm-random-topic', is_admin: true }));
  });

  it('refuses an invalid configured topic instead of silently changing it', async () => {
    const deps = makeDeps();
    expect(await decideLogin(deps, request({ adminUsername: 'aperez', adminTopic: 'bad topic!' }))).toEqual({
      ok: false,
      error: ERR_ADMIN_TOPIC,
    });
    expect(deps.createUser).not.toHaveBeenCalled();
  });

  it('does not bootstrap a second admin: the matching username then needs an invite', async () => {
    const deps = makeDeps({ adminExists: vi.fn(async () => true) });
    expect(await decideLogin(deps, request({ adminUsername: 'aperez' }))).toEqual({ ok: false, error: ERR_NEEDS_INVITE });
    expect(deps.createUser).not.toHaveBeenCalled();
  });

  it('never makes a non-matching username an admin', async () => {
    const deps = makeDeps();
    expect(await decideLogin(deps, request({ adminUsername: 'owner' }))).toEqual({ ok: false, error: ERR_NEEDS_INVITE });
    expect(deps.adminExists).not.toHaveBeenCalled();
  });

  it('treats an unset or blank ADMIN_MOODLE_USERNAME as no bootstrap', () => {
    expect(isBootstrapAdminName('aperez', undefined)).toBe(false);
    expect(isBootstrapAdminName('aperez', '  ')).toBe(false);
    expect(isBootstrapAdminName(' APerez', 'aperez')).toBe(true);
  });
});

describe('new user with invite', () => {
  it('requires a code', async () => {
    const deps = makeDeps();
    expect(await decideLogin(deps, request({ inviteCode: '   ' }))).toEqual({ ok: false, error: ERR_NEEDS_INVITE });
    expect(deps.claimInvite).not.toHaveBeenCalled();
  });

  it('rejects malformed codes before touching the database', async () => {
    const deps = makeDeps();
    expect(await decideLogin(deps, request({ inviteCode: 'x&or=1' }))).toEqual({ ok: false, error: ERR_INVITE });
    expect(deps.claimInvite).not.toHaveBeenCalled();
  });

  it('rejects a code that is invalid, used or expired (zero rows claimed)', async () => {
    const deps = makeDeps({ claimInvite: vi.fn(async () => false) });
    expect(await decideLogin(deps, request({ inviteCode: 'abcdefgh23' }))).toEqual({ ok: false, error: ERR_INVITE });
    expect(deps.createUser).not.toHaveBeenCalled();
  });

  it('claims the normalized code, creates the user with a random topic and records who used it', async () => {
    const deps = makeDeps();
    const out = await decideLogin(deps, request({ inviteCode: ' abcd-efgh23 ' }));
    expect(out).toEqual({ ok: true, userId: 'new-1', created: true, isAdmin: false });
    expect(deps.claimInvite).toHaveBeenCalledWith('ABCDEFGH23', NOW.toISOString());
    expect(deps.createUser).toHaveBeenCalledWith(
      expect.objectContaining({ is_admin: false, ntfy_topic: 'utm-random-topic', username: 'aperez', fullname: 'Ana Perez' }),
    );
    expect(deps.markInviteUsed).toHaveBeenCalledWith('ABCDEFGH23', 'new-1');
    expect(deps.releaseInvite).not.toHaveBeenCalled();
  });

  it('releases the invite and rethrows when creating the user fails', async () => {
    const deps = makeDeps({
      createUser: vi.fn(async () => {
        throw new Error('db down');
      }),
    });
    await expect(decideLogin(deps, request({ inviteCode: 'ABCDEFGH23' }))).rejects.toThrow('db down');
    expect(deps.releaseInvite).toHaveBeenCalledWith('ABCDEFGH23');
    expect(deps.markInviteUsed).not.toHaveBeenCalled();
  });

  it('on a unique-violation race, releases the invite and logs in the existing user', async () => {
    const findUser = vi.fn<LoginDeps['findUser']>().mockResolvedValueOnce(null).mockResolvedValueOnce(user({ id: 'raced' }));
    const deps = makeDeps({ findUser, createUser: vi.fn(async (): Promise<CreateUserResult> => ({ kind: 'conflict' })) });
    const out = await decideLogin(deps, request({ inviteCode: 'ABCDEFGH23' }));
    expect(out).toEqual({ ok: true, userId: 'raced', created: false, isAdmin: false });
    expect(deps.releaseInvite).toHaveBeenCalledWith('ABCDEFGH23');
    expect(deps.updateLogin).toHaveBeenCalledWith('raced', expect.objectContaining({ token: 'tok-1' }));
  });

  it('fails cleanly when the conflict was not on the user identity (e.g. topic collision)', async () => {
    const deps = makeDeps({ createUser: vi.fn(async (): Promise<CreateUserResult> => ({ kind: 'conflict' })) });
    expect(await decideLogin(deps, request({ inviteCode: 'ABCDEFGH23' }))).toEqual({ ok: false, error: ERR_CREATE });
    expect(deps.releaseInvite).toHaveBeenCalledWith('ABCDEFGH23');
  });

  it('a raced user that is inactive stays blocked', async () => {
    const findUser = vi.fn<LoginDeps['findUser']>().mockResolvedValueOnce(null).mockResolvedValueOnce(user({ active: false }));
    const deps = makeDeps({ findUser, createUser: vi.fn(async (): Promise<CreateUserResult> => ({ kind: 'conflict' })) });
    expect(await decideLogin(deps, request({ inviteCode: 'ABCDEFGH23' }))).toEqual({ ok: false, error: ERR_INACTIVE });
  });
});
