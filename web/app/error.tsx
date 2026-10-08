'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { startTransition, useEffect, useRef } from 'react';

/**
 * Route error boundary: replaces the default English screen with a Spanish one. "Reintentar" re-renders the
 * segment and refreshes the server components, so a transient database or network failure recovers in place.
 */
export default function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const router = useRouter();
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    heading.current?.focus();
    // The digest is the server-side reference; the message itself is never shown (it can carry internals).
    console.error('Route error', error.digest ?? error.name);
  }, [error]);

  return (
    <section className="card item error-screen" aria-labelledby="error-title">
      <h1 id="error-title" ref={heading} tabIndex={-1}>
        Algo salió mal
      </h1>
      <p className="muted">No pudimos cargar esta página. Puede ser un problema momentáneo de conexión.</p>
      <div className="actions">
        <button
          type="button"
          className="btn primary"
          onClick={() =>
            startTransition(() => {
              router.refresh();
              reset();
            })
          }
        >
          Reintentar
        </button>
        <Link href="/" className="btn">
          Ir a Tareas
        </Link>
      </div>
    </section>
  );
}
