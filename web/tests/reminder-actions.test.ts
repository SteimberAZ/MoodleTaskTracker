import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;${to}` });
  },
  notFound: vi.fn(),
}));

const USER_ID = '3f2c8a52-8d5e-4a0b-9f0e-6f3a1c2b4d5e';
const REMINDER_ID = '0b9c1f2e-3d4a-4b5c-8d6e-7f8091a2b3c4';

vi.mock('@/lib/auth', () => ({
  requireUser: vi.fn(async () => ({ id: USER_ID, username: 'ana', active: true })),
}));
const session = vi.hoisted(() => ({ endSession: vi.fn(async () => {}) }));
vi.mock('@/lib/session', () => session);

/** A one-row `moodle_custom_reminders` that understands the owner/id/active filters the code sends. */
const db = vi.hoisted(() => {
  const state = {
    row: null as null | Record<string, unknown>,
    calls: [] as { path: string; method: string; body?: Record<string, unknown> }[],
    /** Runs right after a GET answered: simulates another tab writing in between. */
    afterRead: null as null | (() => void),
  };
  const matches = (path: string) => {
    const row = state.row;
    if (!row) return false;
    const query = new URLSearchParams(path.slice(path.indexOf('?') + 1));
    if (query.get('user_id') !== `eq.${row.user_id}`) return false;
    if (query.get('id') && query.get('id') !== `eq.${row.id}`) return false;
    const active = query.get('active');
    return !active || active === `eq.${row.active}`;
  };
  const dbJson = vi.fn(async (path: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    state.calls.push({ path, method, body });
    if (!path.startsWith('moodle_custom_reminders')) return [];
    if (!matches(path)) return [];
    if (method === 'PATCH') state.row = { ...state.row, ...body };
    if (method === 'DELETE') {
      const gone = state.row;
      state.row = null;
      return [gone];
    }
    const snapshot = [{ ...state.row }];
    if (method === 'GET' && state.afterRead) {
      state.afterRead();
      state.afterRead = null;
    }
    return snapshot;
  });
  return { state, dbJson };
});
vi.mock('@/lib/db', () => ({ dbJson: db.dbJson, dbJsonCounted: vi.fn(), dbFetch: vi.fn() }));

import { deleteReminder, reconnectMoodle, setReminderActive, setTaskMute } from '@/app/actions';

const patches = () => db.state.calls.filter((c) => c.method === 'PATCH');

beforeEach(() => {
  db.state.calls = [];
  db.state.row = {
    id: REMINDER_ID,
    user_id: USER_ID,
    title: 'Leer',
    active: true,
    interval_minutes: 60,
    starts_at: '2026-01-01T00:00:00.000Z',
    ends_at: '2999-01-01T00:00:00.000Z',
    next_fire_at: '2026-01-01T01:00:00.000Z',
  };
});

describe('setReminderActive', () => {
  it('pauses with a write conditioned on the state that was read, without touching next_fire_at', async () => {
    await setReminderActive(REMINDER_ID, false);
    expect(patches()).toHaveLength(1);
    expect(patches()[0].path).toContain('active=eq.true');
    expect(patches()[0].body).toMatchObject({ active: false });
    expect(patches()[0].body).not.toHaveProperty('next_fire_at');
    expect(db.state.row?.active).toBe(false);
  });

  it('is idempotent: a double tap on "Pausar" cannot resume it again', async () => {
    await setReminderActive(REMINDER_ID, false);
    await setReminderActive(REMINDER_ID, false);
    expect(patches()).toHaveLength(1);
    expect(db.state.row?.active).toBe(false);
  });

  it('a no-op when the reminder is already in the requested state', async () => {
    await setReminderActive(REMINDER_ID, true);
    expect(patches()).toHaveLength(0);
  });

  it('recomputes next_fire_at only when resuming', async () => {
    db.state.row = { ...db.state.row, active: false };
    await setReminderActive(REMINDER_ID, true);
    expect(patches()).toHaveLength(1);
    expect(patches()[0].path).toContain('active=eq.false');
    expect(patches()[0].body).toMatchObject({ active: true });
    expect(Date.parse(String(patches()[0].body?.next_fire_at))).toBeGreaterThan(Date.now() - 1000);
  });

  it('a write from another tab between the read and the PATCH is not overwritten', async () => {
    // This request read "active", then another tab paused it: the conditional PATCH must match nothing.
    db.state.afterRead = () => {
      db.state.row = { ...db.state.row, active: false, next_fire_at: 'other-tab' };
    };
    await setReminderActive(REMINDER_ID, false);
    expect(patches()).toHaveLength(1);
    expect(db.state.row).toMatchObject({ active: false, next_fire_at: 'other-tab' });
    expect(db.state.row).not.toHaveProperty('updated_at');
  });

  it('ignores unknown or malformed ids', async () => {
    await setReminderActive('not-a-uuid', false);
    expect(patches()).toHaveLength(0);
  });
});

describe('deleteReminder', () => {
  it('returns ok, also when the reminder is already gone', async () => {
    await expect(deleteReminder(REMINDER_ID)).resolves.toEqual({ ok: true });
    await expect(deleteReminder(REMINDER_ID)).resolves.toEqual({ ok: true });
  });

  it('reports a failure instead of throwing', async () => {
    db.dbJson.mockRejectedValueOnce(new Error('down'));
    await expect(deleteReminder(REMINDER_ID)).resolves.toMatchObject({ ok: false, error: expect.any(String) });
  });
});

describe('setTaskMute', () => {
  it('returns an error result when no task matched', async () => {
    await expect(setTaskMute('abc123', true)).resolves.toEqual({ ok: false, error: 'La tarea ya no existe.' });
  });

  it('returns ok when the owner row was updated', async () => {
    db.dbJson.mockResolvedValueOnce([{ id: 'abc123' }]);
    await expect(setTaskMute('abc123', true)).resolves.toEqual({ ok: true });
    const [path, init] = db.dbJson.mock.calls.at(-1)!;
    expect(path).toBe(`moodle_tasks?user_id=eq.${USER_ID}&id=eq.abc123&select=id`);
    expect(JSON.parse(String(init?.body))).toEqual({ is_dismissed: 1 });
  });
});

describe('reconnectMoodle', () => {
  it('ends the session and opens the login for the same account', async () => {
    await expect(reconnectMoodle()).rejects.toMatchObject({ digest: 'NEXT_REDIRECT;/login?u=ana' });
    expect(session.endSession).toHaveBeenCalledTimes(1);
  });
});

describe('action controls markup', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { default: MuteButton } = await import('@/components/MuteButton');
  const { default: ReminderCard, reminderBadgeLabel } = await import('@/components/ReminderCard');
  const text = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, '');

  it('MuteButton names the task in sr-only text instead of overriding the visible label', () => {
    const html = renderToStaticMarkup(createElement(MuteButton, { taskId: 'abc123', muted: false, title: 'Ensayo' }));
    expect(html).not.toContain('aria-label');
    expect(text(html)).toBe('Silenciar «Ensayo»');
    expect(html).toContain('type="submit"');
    expect(html).not.toContain('disabled');
  });

  it('ReminderCard: h2 title, named actions and the "submitted" stop label', () => {
    const r = {
      ...(db.state.row as object),
      message: null,
      last_sent_at: null,
      created_at: '',
      updated_at: '',
      active: false,
    } as never;
    const html = renderToStaticMarkup(
      createElement(ReminderCard, {
        reminder: r,
        status: 'pausado',
        hasTask: true,
        task: { id: 'abc123', title: 'Ensayo', status: 'submitted' },
      }),
    );
    expect(html).toContain('<h2 class="task-title"');
    expect(text(html)).toContain('Detenido: tarea entregada');
    expect(text(html)).toContain('Reanudar «Leer»');
    expect(text(html)).toContain('Editar «Leer»');
    expect(text(html)).toContain('Eliminar «Leer»');
    expect(reminderBadgeLabel('activo', { active: true }, { status: 'submitted' })).toBe('activo');
    expect(reminderBadgeLabel('pausado', { active: false }, { status: 'new' })).toBe('pausado');
  });
});
