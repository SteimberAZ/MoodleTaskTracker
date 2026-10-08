'use client';

import type { ReactElement } from 'react';
import Link, { useLinkStatus } from 'next/link';
import { usePathname } from 'next/navigation';
import { LOGIN_PATH, buildNavItems, type NavIconName } from '@/lib/nav';
import { BellIcon, ClockIcon, ShieldIcon, TasksIcon, UserIcon } from './Icons';

const ICONS: Record<NavIconName, () => ReactElement> = {
  tasks: TasksIcon,
  reminders: ClockIcon,
  bell: BellIcon,
  user: UserIcon,
  shield: ShieldIcon,
};

/**
 * Invisible marker inside each <Link>: `useLinkStatus` only works in a descendant of the link. While that link's
 * navigation is pending it sets `data-pending`, and skeleton.css dims the tab (feedback before the page streams in).
 */
function PendingMark() {
  const { pending } = useLinkStatus();
  return <span className="nav-pending" aria-hidden="true" data-pending={pending ? 'true' : undefined} />;
}

/**
 * The app navigation: Tareas / Recordatorios / Notificaciones / Mi cuenta / Admin (admins only).
 * Logout is not a tab; it sits at the right end of the header (see LogoutButton).
 * Rendered twice by SiteHeader: `inline` inside the header (wide screens only) and `bar` as a bottom tab bar
 * (phones only). The bar must live OUTSIDE the sticky header: iOS WebKit mispositions `position: fixed`
 * descendants of a sticky ancestor, which made the bar float up on short pages.
 */
export default function NavLinks({ isAdmin, variant }: { isAdmin: boolean; variant: 'inline' | 'bar' }) {
  const pathname = usePathname() ?? '/';

  return (
    <nav className={`site-nav site-nav--${variant}`} aria-label="Principal">
      {buildNavItems(isAdmin, pathname).map(({ href, label, shortLabel, icon, current }) => {
        const Icon = ICONS[icon];
        return (
          <Link key={href} href={href} className="nav-item" aria-current={current ? 'page' : undefined}>
            <Icon />
            {shortLabel ? (
              <>
                {/* Short label on phones so five tabs fit in 320px. Only one of the two is displayed at a time
                    (CSS display: none hides the other from assistive tech too), so the accessible name is
                    always the visible text (WCAG 2.5.3 label in name; voice control users say what they see). */}
                <span className="nav-label-short">{shortLabel}</span>
                <span className="nav-label-long">{label}</span>
              </>
            ) : (
              <span>{label}</span>
            )}
            <PendingMark />
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * Stand-in for the user navigation while the session query streams in (SiteHeader's Suspense fallback). It keeps
 * the `.site-nav` element on the page so the `body:has(.site-nav)` padding rules do not change when the real nav
 * arrives, reserves the inline nav and logout height in the header, and is empty for assistive tech. On the
 * login page there is never a nav, so it renders nothing there.
 */
export function NavPlaceholder({ variant }: { variant: 'inline' | 'bar' }) {
  const pathname = usePathname() ?? '';
  if (pathname === LOGIN_PATH || pathname.startsWith(`${LOGIN_PATH}/`)) return null;
  return (
    <>
      <div className={`site-nav site-nav--${variant} nav-placeholder`} aria-hidden="true" />
      {variant === 'inline' && <span className="logout-placeholder" aria-hidden="true" />}
    </>
  );
}
