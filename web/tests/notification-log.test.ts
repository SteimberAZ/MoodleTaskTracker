import { describe, expect, it } from 'vitest';
import {
  BODY_PREVIEW_CHARS,
  HISTORY_COLUMNS,
  HISTORY_FILTERS,
  bodyIsLong,
  channelBadges,
  clearHistoryQuery,
  dayHeaderLabel,
  groupByDay,
  historyKindParts,
  historyPageQuery,
  notificationDomId,
  notificationRowQuery,
  notificationTargetHref,
  notificationTimeLabel,
  notificationsHref,
  parseHistoryFilter,
  parseNotificationParam,
  relativeLabel,
  safeNotificationHref,
} from '@/lib/notification-log';

const USER = '3f2c8a52-8d5e-4a0b-9f0e-6f3a1c2b4d5e';
// 2026-10-07 02:30 UTC = 2026-10-06 21:30 in Ecuador (UTC-5).
const NOW = new Date('2026-10-07T02:30:00Z');

describe('parseHistoryFilter', () => {
  it('defaults to todos', () => {
    expect(parseHistoryFilter(undefined)).toBe('todos');
    expect(parseHistoryFilter('nope')).toBe('todos');
    expect(parseHistoryFilter('task')).toBe('todos');
  });

  it('accepts the five chips', () => {
    for (const { value } of HISTORY_FILTERS) expect(parseHistoryFilter(value)).toBe(value);
    expect(parseHistoryFilter(['clases', 'x'])).toBe('clases');
  });
});

describe('historyKindParts', () => {
  it('maps each chip to its kinds; Sistema is status + test', () => {
    expect(historyKindParts('todos')).toEqual([]);
    expect(historyKindParts('tareas')).toEqual(['kind=eq.task']);
    expect(historyKindParts('recordatorios')).toEqual(['kind=eq.reminder']);
    expect(historyKindParts('clases')).toEqual(['kind=eq.class']);
    expect(historyKindParts('sistema')).toEqual(['kind=in.(status,test)']);
  });
});

describe('historyPageQuery', () => {
  it('always starts with the owner filter, for every chip and page', () => {
    for (const { value } of HISTORY_FILTERS) {
      for (const page of [1, 2, 50]) {
        expect(historyPageQuery(USER, value, page).startsWith(`?user_id=eq.${USER}&`)).toBe(true);
      }
    }
  });

  it('selects only the needed columns, newest first, 20 per page', () => {
    expect(historyPageQuery(USER, 'todos', 1)).toBe(
      `?user_id=eq.${USER}&select=id,kind,title,body,url,status,push_ok,push_total,ntfy_attempted,ntfy_ok,created_at` +
        '&order=created_at.desc,id.desc&limit=20&offset=0',
    );
    expect(historyPageQuery(USER, 'todos', 1)).not.toContain('select=*');
    expect(historyPageQuery(USER, 'todos', 1)).not.toContain('tag');
  });

  it('adds the kind filter and paginates with limit and offset', () => {
    const q = historyPageQuery(USER, 'sistema', 3);
    expect(q).toContain('&kind=in.(status,test)&');
    expect(q).toMatch(/limit=20&offset=40$/);
    expect(historyPageQuery(USER, 'tareas', 2)).toContain('kind=eq.task');
  });

  it('treats an invalid page as the first one', () => {
    expect(historyPageQuery(USER, 'todos', 0)).toMatch(/offset=0$/);
    expect(historyPageQuery(USER, 'todos', Number.NaN)).toMatch(/offset=0$/);
  });

  it('refuses a malformed user id', () => {
    expect(() => historyPageQuery('x&user_id=neq.1', 'todos', 1)).toThrow();
    expect(() => historyPageQuery('', 'todos', 1)).toThrow();
    expect(() => clearHistoryQuery('not-a-uuid')).toThrow();
  });
});

describe('clearHistoryQuery', () => {
  it('deletes only the rows of the session user', () => {
    expect(clearHistoryQuery(USER)).toBe(`?user_id=eq.${USER}`);
  });
});

describe('notificationsHref', () => {
  it('omits default state and keeps the filter and page otherwise', () => {
    expect(notificationsHref({})).toBe('/notificaciones');
    expect(notificationsHref({ hk: 'todos', hp: 1 })).toBe('/notificaciones');
    expect(notificationsHref({ hk: 'clases', hp: 3 }, 'historial')).toBe('/notificaciones?hk=clases&hp=3#historial');
    expect(notificationsHref({ hp: 2 })).toBe('/notificaciones?hp=2');
  });
});

describe('safeNotificationHref', () => {
  it('accepts same-origin relative paths', () => {
    expect(safeNotificationHref('/tareas/abc123')).toBe('/tareas/abc123');
    expect(safeNotificationHref('/recordatorios')).toBe('/recordatorios');
    expect(safeNotificationHref('/horario')).toBe('/horario');
    expect(safeNotificationHref('/notificaciones?hk=clases#historial')).toBe('/notificaciones?hk=clases#historial');
  });

  it('rejects absolute, protocol-relative and scheme URLs', () => {
    expect(safeNotificationHref('https://evil.example/x')).toBeNull();
    expect(safeNotificationHref('//evil.example/x')).toBeNull();
    expect(safeNotificationHref('javascript:alert(1)')).toBeNull();
    expect(safeNotificationHref('data:text/html,hi')).toBeNull();
    expect(safeNotificationHref('tareas/abc')).toBeNull();
  });

  it('rejects slash tricks, control characters and spaces', () => {
    expect(safeNotificationHref('/\\evil.example')).toBeNull();
    expect(safeNotificationHref('/\t/evil.example')).toBeNull();
    expect(safeNotificationHref('/\nfoo')).toBeNull();
    expect(safeNotificationHref('/a b')).toBeNull();
  });

  it('rejects empty, missing and oversized values', () => {
    expect(safeNotificationHref('')).toBeNull();
    expect(safeNotificationHref(null)).toBeNull();
    expect(safeNotificationHref(undefined)).toBeNull();
    expect(safeNotificationHref(`/${'a'.repeat(600)}`)).toBeNull();
  });
});

describe('time labels (America/Guayaquil)', () => {
  it('says hoy / ayer / date by the Ecuador calendar day', () => {
    // 2026-10-06 21:30 local: same day as NOW, even though UTC is already the 7th.
    expect(notificationTimeLabel('2026-10-07T02:10:00Z', NOW)).toBe('hoy 21:10');
    expect(notificationTimeLabel('2026-10-06T12:30:00Z', NOW)).toBe('hoy 07:30');
    // 2026-10-05 21:10 local: yesterday.
    expect(notificationTimeLabel('2026-10-06T02:10:00Z', NOW)).toBe('ayer 21:10');
    expect(notificationTimeLabel('2026-10-03T03:05:00Z', NOW)).toBe('02/10 22:05');
  });

  it('flips at Ecuador midnight, not at UTC midnight', () => {
    const justAfter = new Date('2026-10-07T05:01:00Z'); // 00:01 on the 7th in Ecuador
    expect(notificationTimeLabel('2026-10-07T04:59:00Z', justAfter)).toBe('ayer 23:59');
    expect(notificationTimeLabel('2026-10-07T05:00:00Z', justAfter)).toBe('hoy 00:00');
  });

  it('returns a dash for an invalid date', () => {
    expect(notificationTimeLabel('not a date', NOW)).toBe('—');
  });

  it('labels day headers', () => {
    expect(dayHeaderLabel('2026-10-07T02:10:00Z', NOW)).toBe('Hoy');
    expect(dayHeaderLabel('2026-10-06T02:10:00Z', NOW)).toBe('Ayer');
    expect(dayHeaderLabel('2026-10-03T15:00:00Z', NOW)).toBe('sáb 03/10');
    expect(dayHeaderLabel('2025-12-31T03:00:00Z', NOW)).toBe('mar 30/12/2025');
    expect(dayHeaderLabel('garbage', NOW)).toBe('Fecha desconocida');
  });

  it('describes elapsed time', () => {
    const at = (iso: string) => relativeLabel(iso, NOW);
    expect(at('2026-10-07T02:29:40Z')).toBe('ahora');
    expect(at('2026-10-07T02:25:00Z')).toBe('hace 5 min');
    expect(at('2026-10-06T23:30:00Z')).toBe('hace 3 h');
    expect(at('2026-10-04T02:30:00Z')).toBe('hace 3 d');
    expect(at('2026-07-01T02:30:00Z')).toBeNull();
    expect(at('bad')).toBeNull();
    expect(at('2026-10-07T03:30:00Z')).toBe('ahora'); // slightly in the future (clock skew)
  });
});

describe('groupByDay', () => {
  const row = (id: string, created_at: string) => ({ id, created_at });

  it('groups consecutive rows by Ecuador day, newest first, around midnight', () => {
    const rows = [
      row('a', '2026-10-07T02:10:00Z'), // 21:10 on the 6th (Ecuador)
      row('b', '2026-10-06T14:00:00Z'), // 09:00 on the 6th
      row('c', '2026-10-06T04:59:00Z'), // 23:59 on the 5th
      row('d', '2026-10-06T05:00:00Z'), // 00:00 on the 6th
    ];
    // Input order is the caller's responsibility (query order); 'd' after 'c' opens a new group.
    const groups = groupByDay(rows, NOW);
    expect(groups.map((g) => [g.key, g.label, g.items.map((i) => i.id)])).toEqual([
      ['2026-10-06', 'Hoy', ['a', 'b']],
      ['2026-10-05', 'Ayer', ['c']],
      ['2026-10-06', 'Hoy', ['d']],
    ]);
  });

  it('puts invalid dates in their own group', () => {
    const groups = groupByDay([row('x', 'nope'), row('y', 'nope')], NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ key: 'unknown', label: 'Fecha desconocida' });
  });

  it('returns no groups for no rows', () => {
    expect(groupByDay([], NOW)).toEqual([]);
  });
});

describe('channelBadges', () => {
  const base = { status: 'sent', push_ok: 2, push_total: 2, ntfy_attempted: false, ntfy_ok: false };

  it('shows Push ok/total and nothing for ntfy when it was not attempted', () => {
    expect(channelBadges(base)).toEqual([
      { key: 'push', text: 'Push 2/2', srText: 'Push: 2 de 2 dispositivos', tone: 'activo' },
    ]);
  });

  it('flags partial or failed push as a warning with the counts in the text', () => {
    expect(channelBadges({ ...base, push_ok: 0, push_total: 1 })[0]).toMatchObject({ text: 'Push 0/1', tone: 'urgente' });
    expect(channelBadges({ ...base, push_ok: 1 })[0]).toMatchObject({ text: 'Push 1/2', tone: 'urgente' });
  });

  it('adds ntfy only when attempted', () => {
    expect(channelBadges({ ...base, ntfy_attempted: true, ntfy_ok: true }).map((b) => b.text)).toEqual(['Push 2/2', 'ntfy ✓']);
    expect(channelBadges({ ...base, ntfy_attempted: true, ntfy_ok: false }).map((b) => b.text)).toEqual(['Push 2/2', 'ntfy ✗']);
  });

  it('marks failed deliveries with accessible text first', () => {
    const badges = channelBadges({ ...base, status: 'failed', push_ok: 0, push_total: 1 });
    expect(badges[0]).toEqual({ key: 'status', text: 'No entregada', tone: 'urgente' });
    expect(badges.map((b) => b.text)).toEqual(['No entregada', 'Push 0/1']);
  });

  it('hides push when the user had no device and tolerates nulls', () => {
    expect(channelBadges({ status: 'sent', push_ok: null, push_total: null, ntfy_attempted: null, ntfy_ok: null })).toEqual([]);
    expect(channelBadges({ ...base, push_ok: 0, push_total: 0 })).toEqual([]);
  });

  it('never reports more devices ok than the total', () => {
    expect(channelBadges({ ...base, push_ok: 5, push_total: 2 })[0].text).toBe('Push 2/2');
  });
});

describe('bodyIsLong', () => {
  it('is false for empty and short single-line bodies', () => {
    expect(bodyIsLong(null)).toBe(false);
    expect(bodyIsLong('')).toBe(false);
    expect(bodyIsLong('Vence mañana a las 23:59')).toBe(false);
  });

  it('is true past the preview length or beyond two lines', () => {
    expect(bodyIsLong('x'.repeat(BODY_PREVIEW_CHARS))).toBe(false);
    expect(bodyIsLong('x'.repeat(BODY_PREVIEW_CHARS + 1))).toBe(true);
    expect(bodyIsLong('a\nb\nc')).toBe(true);
    expect(bodyIsLong('a\nb')).toBe(false);
  });
});

describe('parseNotificationParam (?n=)', () => {
  const ID = '7b1f6c1e-3a52-4a52-9d0e-0c5f3a9a1b11';

  it('accepts a uuid, lowercased, and the first of repeated values', () => {
    expect(parseNotificationParam(ID)).toBe(ID);
    expect(parseNotificationParam(ID.toUpperCase())).toBe(ID);
    expect(parseNotificationParam([ID, 'x'])).toBe(ID);
  });

  it('ignores anything that is not a uuid, so it never reaches a query', () => {
    for (const bad of [undefined, null, '', 'abc', '1', `${ID}&user_id=neq.1`, `${ID} `, `eq.${ID}`, ID.slice(1), '*']) {
      expect(parseNotificationParam(bad)).toBeNull();
    }
    expect(parseNotificationParam(['nope', ID])).toBeNull();
  });
});

describe('notificationRowQuery', () => {
  const ID = '7b1f6c1e-3a52-4a52-9d0e-0c5f3a9a1b11';

  it('reads one row scoped to the session user', () => {
    expect(notificationRowQuery(USER, ID)).toBe(`?user_id=eq.${USER}&id=eq.${ID}&${HISTORY_COLUMNS}&limit=1`);
  });

  it('refuses ids and users that are not uuids', () => {
    expect(() => notificationRowQuery(USER, `${ID}&user_id=neq.1`)).toThrow();
    expect(() => notificationRowQuery(USER, 'abc')).toThrow();
    expect(() => notificationRowQuery('x&user_id=neq.1', ID)).toThrow();
  });
});

describe('notificationTargetHref', () => {
  it('offers a safe same-origin page', () => {
    expect(notificationTargetHref('/tareas/abc')).toBe('/tareas/abc');
    expect(notificationTargetHref('/horario')).toBe('/horario');
  });

  it('offers nothing for Avisos itself, absolute or unsafe urls', () => {
    expect(notificationTargetHref('/notificaciones')).toBeNull();
    expect(notificationTargetHref('/notificaciones?hk=clases#historial')).toBeNull();
    expect(notificationTargetHref('https://evil.example/')).toBeNull();
    expect(notificationTargetHref('//evil.example')).toBeNull();
    expect(notificationTargetHref('javascript:alert(1)')).toBeNull();
    expect(notificationTargetHref(null)).toBeNull();
  });
});

describe('notificationDomId', () => {
  it('prefixes the row id', () => {
    expect(notificationDomId('abc')).toBe('n-abc');
  });
});
