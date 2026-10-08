/** Pure navigation model: which tabs exist, which one is active, and where reminder flows return to. */

export const TASKS_PATH = '/';
export const REMINDERS_PATH = '/recordatorios';
export const STATS_PATH = '/estadisticas';
/** The class schedule lives inside Recordatorios (a segment at the top of both pages), so it gets no tab of its own. */
export const SCHEDULE_PATH = '/horario';
/** The only page without the app navigation (logged out). */
export const LOGIN_PATH = '/login';

export type NavIconName = 'tasks' | 'chart' | 'reminders' | 'bell' | 'user' | 'shield';

export interface NavItem {
  href: string;
  /** Full label (wide screens, accessible name). */
  label: string;
  /** Compact label for the phone tab bar; only set when the full one does not fit in 320px. */
  shortLabel?: string;
  icon: NavIconName;
  current: boolean;
}

/** True when `pathname` is `base` itself or lives under it (segment boundary, so `/cuentas` is not `/cuenta`). */
function within(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(`${base}/`);
}

/** Whether the tab pointing at `href` is the current route. Detail and form pages keep their section active. */
export function isNavActive(href: string, pathname: string): boolean {
  if (href === TASKS_PATH) return pathname === TASKS_PATH || within(pathname, '/tareas');
  if (href === REMINDERS_PATH) {
    return within(pathname, REMINDERS_PATH) || within(pathname, '/reminders') || within(pathname, SCHEDULE_PATH);
  }
  return within(pathname, href);
}

/**
 * Tabs of the main navigation, in display order. Logout is deliberately not a tab: it lives at the
 * right end of the header. Admin appears for admins only: five tabs for users, six for admins.
 */
export function buildNavItems(isAdmin: boolean, pathname: string): NavItem[] {
  const items: Omit<NavItem, 'current'>[] = [
    { href: TASKS_PATH, label: 'Tareas', icon: 'tasks' },
    { href: STATS_PATH, label: 'Estadísticas', shortLabel: 'Notas', icon: 'chart' },
    { href: REMINDERS_PATH, label: 'Recordatorios', shortLabel: 'Recordar', icon: 'reminders' },
    { href: '/notificaciones', label: 'Notificaciones', shortLabel: 'Avisos', icon: 'bell' },
    { href: '/cuenta', label: 'Mi cuenta', shortLabel: 'Cuenta', icon: 'user' },
  ];
  if (isAdmin) items.push({ href: '/admin', label: 'Admin', icon: 'shield' });
  return items.map((item) => ({ ...item, current: isNavActive(item.href, pathname) }));
}
