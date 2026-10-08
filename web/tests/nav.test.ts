import { describe, expect, it } from 'vitest';
import { REMINDERS_PATH, SCHEDULE_PATH, TASKS_PATH, buildNavItems, isNavActive } from '@/lib/nav';

const hrefs = (isAdmin: boolean) => buildNavItems(isAdmin, '/').map((i) => i.href);
const labels = (isAdmin: boolean) => buildNavItems(isAdmin, '/').map((i) => i.label);

describe('buildNavItems', () => {
  it('shows four tabs to a regular user, in order', () => {
    expect(hrefs(false)).toEqual(['/', '/recordatorios', '/notificaciones', '/cuenta']);
    expect(labels(false)).toEqual(['Tareas', 'Recordatorios', 'Notificaciones', 'Mi cuenta']);
  });

  it('adds Admin last for admins, for five tabs at most', () => {
    expect(hrefs(true)).toEqual(['/', '/recordatorios', '/notificaciones', '/cuenta', '/admin']);
    expect(buildNavItems(true, '/')).toHaveLength(5);
  });

  it('has no logout tab: logout lives in the header', () => {
    for (const isAdmin of [false, true]) {
      const items = buildNavItems(isAdmin, '/');
      expect(items.some((i) => /salir|cerrar sesi|logout/i.test(i.label) || /logout/i.test(i.href))).toBe(false);
    }
  });

  it('gives the long tabs a short phone label', () => {
    const byHref = Object.fromEntries(buildNavItems(false, '/').map((i) => [i.href, i.shortLabel]));
    expect(byHref['/notificaciones']).toBe('Avisos');
    expect(byHref['/recordatorios']).toBe('Recordar');
    expect(byHref['/']).toBeUndefined();
  });

  it('marks exactly one tab as current', () => {
    const current = (pathname: string) => buildNavItems(true, pathname).filter((i) => i.current).map((i) => i.href);
    expect(current('/')).toEqual(['/']);
    expect(current('/tareas/abc123')).toEqual(['/']);
    expect(current('/recordatorios')).toEqual(['/recordatorios']);
    expect(current('/notificaciones')).toEqual(['/notificaciones']);
    expect(current('/cuenta')).toEqual(['/cuenta']);
    expect(current('/admin')).toEqual(['/admin']);
  });

  it('marks nothing as current on unrelated routes', () => {
    expect(buildNavItems(true, '/login').some((i) => i.current)).toBe(false);
    expect(buildNavItems(false, '/admin').some((i) => i.current)).toBe(false);
  });
});

describe('isNavActive', () => {
  it('keeps Recordatorios active on the form and edit pages (old paths kept)', () => {
    expect(isNavActive(REMINDERS_PATH, '/reminders/new')).toBe(true);
    expect(isNavActive(REMINDERS_PATH, '/reminders/42/edit')).toBe(true);
    expect(isNavActive(REMINDERS_PATH, '/recordatorios')).toBe(true);
    expect(isNavActive(TASKS_PATH, '/reminders/new')).toBe(false);
  });

  it('keeps Recordatorios active on the class schedule page (no sixth tab)', () => {
    expect(isNavActive(REMINDERS_PATH, SCHEDULE_PATH)).toBe(true);
    expect(isNavActive(REMINDERS_PATH, '/horariox')).toBe(false);
    expect(buildNavItems(true, SCHEDULE_PATH).filter((i) => i.current).map((i) => i.href)).toEqual(['/recordatorios']);
    expect(buildNavItems(true, '/')).toHaveLength(5);
  });

  it('only matches whole path segments', () => {
    expect(isNavActive('/cuenta', '/cuentas')).toBe(false);
    expect(isNavActive('/cuenta', '/cuenta/otra')).toBe(true);
    expect(isNavActive(REMINDERS_PATH, '/recordatorios-viejos')).toBe(false);
    expect(isNavActive(TASKS_PATH, '/tareasx')).toBe(false);
  });
});

describe('reminder flow target', () => {
  it('returns to the reminders section, not to home', () => {
    expect(REMINDERS_PATH).toBe('/recordatorios');
    expect(REMINDERS_PATH).not.toBe(TASKS_PATH);
  });
});
