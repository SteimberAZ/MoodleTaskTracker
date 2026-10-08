import { Suspense } from 'react';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth';
import LogoutButton from './LogoutButton';
import NavLinks, { NavPlaceholder } from './NavLinks';

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

/** Navigation and logout of the signed-in user. Resolves after the session lookup; the header does not wait for it. */
async function HeaderUserNav() {
  const user = await getCurrentUser().catch(() => null);
  if (!user) return null;
  return (
    <>
      <NavLinks isAdmin={user.is_admin} variant="inline" />
      <LogoutButton />
    </>
  );
}

/** Phones: bottom tab bar, kept outside the sticky header so `position: fixed` anchors to the viewport. */
async function BottomUserNav() {
  const user = await getCurrentUser().catch(() => null);
  return user ? <NavLinks isAdmin={user.is_admin} variant="bar" /> : null;
}

/**
 * Sticky header shared by every page: logo on the left, navigation, logout at the right end.
 * The header and the logo render synchronously, so a cold open paints the shell before the session query
 * returns; the user-dependent parts stream in behind placeholders that reserve their space (see NavPlaceholder).
 * Logged out (or when the session cannot be resolved) it shows just the logo.
 */
export function SiteHeader() {
  return (
    <>
      <header className="site-header">
        <Brand />
        <Suspense fallback={<NavPlaceholder variant="inline" />}>
          <HeaderUserNav />
        </Suspense>
      </header>
      <Suspense fallback={<NavPlaceholder variant="bar" />}>
        <BottomUserNav />
      </Suspense>
    </>
  );
}
