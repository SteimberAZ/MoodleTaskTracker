import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const dbFetch = vi.fn();
const dbJson = vi.fn();
vi.mock('@/lib/db', () => ({
  dbFetch: (...args: unknown[]) => dbFetch(...args),
  dbJson: (...args: unknown[]) => dbJson(...args),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
const USER = {
  id: '3f2c8a52-8d5e-4a0b-9f0e-6f3a1c2b4d5e',
  username: 'u',
  fullname: null,
  ntfy_topic: 'topic-abc',
  is_admin: false,
  active: true,
  last_error: null,
};
vi.mock('@/lib/auth', () => ({ requireUser: async () => USER }));

const { confirmNtfy, getNtfyStatus, ntfyConfirmRequest, ntfyStatusQuery } = await import('@/lib/ntfy-status');
const actions = await import('@/app/cuenta/actions');

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const MISSING = { code: '42703', message: 'column moodle_users.ntfy_confirmed_at does not exist' };

beforeEach(() => {
  dbFetch.mockReset();
  dbJson.mockReset();
});

afterEach(() => vi.unstubAllGlobals());

describe('ntfy status reads', () => {
  it('reads the switch and the confirmation of the session user', async () => {
    dbFetch.mockResolvedValueOnce(json(200, [{ ntfy_enabled: true, ntfy_confirmed_at: '2026-10-08T12:00:00.000Z' }]));
    expect(await getNtfyStatus(USER.id)).toEqual({
      enabled: true,
      confirmedAt: '2026-10-08T12:00:00.000Z',
      confirmationSupported: true,
    });
    expect(dbFetch.mock.calls[0][0]).toBe(`moodle_users?id=eq.${USER.id}&select=ntfy_enabled,ntfy_confirmed_at&limit=1`);
  });

  it('falls back without ntfy_confirmed_at while the column is missing', async () => {
    dbFetch.mockResolvedValueOnce(json(400, MISSING)).mockResolvedValueOnce(json(200, [{ ntfy_enabled: false }]));
    expect(await getNtfyStatus(USER.id)).toEqual({ enabled: false, confirmedAt: null, confirmationSupported: false });
    expect(dbFetch.mock.calls[1][0]).toBe(`moodle_users${ntfyStatusQuery(USER.id, false)}`);
  });

  it('never throws', async () => {
    dbFetch.mockRejectedValueOnce(new Error('down'));
    expect(await getNtfyStatus(USER.id)).toEqual({ enabled: true, confirmedAt: null, confirmationSupported: false });
  });
});

describe('confirmNtfy', () => {
  it('patches only the session user row', async () => {
    dbFetch.mockResolvedValueOnce(json(200, [{ id: USER.id }]));
    expect(await confirmNtfy(USER.id)).toBe(true);
    const [path, init] = dbFetch.mock.calls[0] as [string, { method: string; body: string }];
    expect(path).toBe(`moodle_users?id=eq.${USER.id}&select=id`);
    expect(init.method).toBe('PATCH');
    expect(Number.isNaN(Date.parse(JSON.parse(init.body).ntfy_confirmed_at))).toBe(false);
    expect(ntfyConfirmRequest(USER.id, null).body).toEqual({ ntfy_confirmed_at: null });
  });

  it("reports 'unsupported' for a missing column and false for other failures", async () => {
    dbFetch.mockResolvedValueOnce(json(400, MISSING));
    expect(await confirmNtfy(USER.id)).toBe('unsupported');
    dbFetch.mockResolvedValueOnce(json(500, {}));
    expect(await confirmNtfy(USER.id)).toBe(false);
    dbFetch.mockResolvedValueOnce(json(200, []));
    expect(await confirmNtfy(USER.id)).toBe(false);
  });
});

describe('account actions', () => {
  it('a successful ntfy test confirms ntfy; a missing column does not fail the test', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })));
    dbFetch.mockResolvedValueOnce(json(400, MISSING));
    const result = await actions.sendTestNotification({}, new FormData());
    expect(result.ok).toBe(true);
    expect(dbFetch).toHaveBeenCalledOnce();
    expect(JSON.parse((dbFetch.mock.calls[0][1] as { body: string }).body)).toHaveProperty('ntfy_confirmed_at');
  });

  it('"Ya me suscribí" reports an error instead of throwing', async () => {
    dbFetch.mockResolvedValueOnce(json(200, [{ id: USER.id }]));
    expect(await actions.confirmNtfySubscription({}, new FormData())).toEqual({ confirmed: true });
    dbFetch.mockResolvedValueOnce(json(400, MISSING));
    expect((await actions.confirmNtfySubscription({}, new FormData())).error).toBeTruthy();
  });

  it('turning ntfy off without push devices warns but still saves', async () => {
    dbJson.mockImplementation(async (path: string) => (path.startsWith('moodle_users') ? [{ id: USER.id }] : []));
    const form = new FormData();
    form.set('enabled', 'false');
    const off = await actions.setNtfyDelivery({}, form);
    expect(off.enabled).toBe(false);
    expect(off.warning).toContain('no recibirás avisos');

    dbJson.mockImplementation(async (path: string) => (path.startsWith('moodle_users') ? [{ id: USER.id }] : [{ id: 'x' }]));
    const withDevice = await actions.setNtfyDelivery({}, form);
    expect(withDevice).toEqual({ enabled: false });
  });

  it('regenerateTopic returns an error state instead of throwing', async () => {
    dbFetch.mockResolvedValue(json(500, {}));
    expect(await actions.regenerateTopic({}, new FormData())).toEqual({
      error: 'No se pudo regenerar el tema. Inténtalo de nuevo.',
    });
    dbFetch.mockReset();
    dbFetch.mockResolvedValueOnce(new Response(null, { status: 204 })).mockResolvedValueOnce(json(200, [{ id: USER.id }]));
    expect(await actions.regenerateTopic({}, new FormData())).toEqual({ ok: true });
    expect(JSON.parse((dbFetch.mock.calls[1][1] as { body: string }).body)).toEqual({ ntfy_confirmed_at: null });
  });
});
