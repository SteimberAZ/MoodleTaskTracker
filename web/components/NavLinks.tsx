'use client';

import type { ReactElement } from 'react';
import Link from 'next/link';
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
 * The app navigation: Tareas / Recordatorios / Notificaciones / Mi cuenta / Admin (admins only).
 * Logout is not a tab; it sits at the right end of the header (see LogoutButton).
 * On phones it is a bottom tab bar (see `.site-nav` in globals.css); on wide screens it sits in the header.
 */
export default function NavLinks({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname() ?? '/';

  return (
    <nav className="site-nav" aria-label="Principal">
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
          </Link>
        );
      })}
    </nav>
  );
}
