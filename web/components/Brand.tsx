import Link from 'next/link';

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

/** Floating pill header shared by every page. */
export function SiteHeader() {
  return (
    <header className="site-header">
      <Brand />
      <nav className="site-nav" aria-label="Principal">
        <Link href="/" className="site-nav-link">Recordatorios</Link>
        <Link href="/cuenta" className="site-nav-cta">Mi cuenta</Link>
      </nav>
    </header>
  );
}
