import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth';
import LogoutButton from './LogoutButton';
import NavLinks from './NavLinks';

/** Logo plus the "mineral / tareas" wordmark. Swaps the cap colour in dark mode. */
export default function Brand() {
  return (
    <Link href="/" className="brand" aria-label="mineral tareas, inicio">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcSet="/brand/logo-dark.svg" />
        <img src="/brand/logo.svg" alt="" width={33} height={40} className="brand-logo" />
      </picture>
      <span className="brand-word" aria-hidden="true">
        mineral
        <small className="brand-sub">tareas</small>
      </span>
    </Link>
  );
}

/**
 * Sticky header shared by every page: logo on the left, navigation, logout at the right end.
 * Logged out (or when the session cannot be resolved) it shows just the logo.
 */
export async function SiteHeader() {
  const user = await getCurrentUser().catch(() => null);
  return (
    <header className="site-header">
      <Brand />
      {user && <NavLinks isAdmin={user.is_admin} />}
      {user && <LogoutButton />}
    </header>
  );
}
