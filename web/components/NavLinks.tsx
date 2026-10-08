'use client';

import type { ReactElement } from 'react';
import Link, { useLinkStatus } from 'next/link';
import { usePathname } from 'next/navigation';
import { buildNavItems, type NavIconName } from '@/lib/nav';
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
          <Link key={href} href={href} className="nav-item" aria-current={current ? 'page' : undefined} aria-label={shortLabel ? label : undefined}>
            <Icon />
            {shortLabel ? (
              <>
                {/* Short label on phones so five tabs fit in 320px. */}
                <span className="nav-label-short" aria-hidden="true">{shortLabel}</span>
                <span className="nav-label-long" aria-hidden="true">{label}</span>
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
