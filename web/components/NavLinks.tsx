'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { logout } from '@/app/actions';
import { BellIcon, HomeIcon, LogOutIcon, ShieldIcon, UserIcon } from './Icons';

/**
 * The single app navigation: Inicio / Notificaciones / Mi cuenta / Admin (admins only) / Salir.
 * On phones it is a bottom tab bar (see `.site-nav` in globals.css); on wide screens it sits in the header.
 */
export default function NavLinks({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname() ?? '/';
  const current = (href: string) =>
    (href === '/' ? pathname === '/' || pathname.startsWith('/tareas') || pathname.startsWith('/reminders') : pathname.startsWith(href))
      ? ('page' as const)
      : undefined;

  return (
    <nav className="site-nav" aria-label="Principal">
      <Link href="/" className="nav-item" aria-current={current('/')}>
        <HomeIcon />
        <span>Inicio</span>
      </Link>
      <Link href="/notificaciones" className="nav-item" aria-current={current('/notificaciones')} aria-label="Notificaciones">
        <BellIcon />
        {/* Short label on phones so five tabs fit in 320px. */}
        <span className="nav-label-short" aria-hidden="true">Avisos</span>
        <span className="nav-label-long" aria-hidden="true">Notificaciones</span>
      </Link>
      <Link href="/cuenta" className="nav-item" aria-current={current('/cuenta')}>
        <UserIcon />
        <span>Mi cuenta</span>
      </Link>
      {isAdmin && (
        <Link href="/admin" className="nav-item" aria-current={current('/admin')}>
          <ShieldIcon />
          <span>Admin</span>
        </Link>
      )}
      <form action={logout} className="nav-form">
        <button type="submit" className="nav-item">
          <LogOutIcon />
          <span>Salir</span>
        </button>
      </form>
    </nav>
  );
}
