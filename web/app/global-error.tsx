'use client';

import { useEffect, useRef } from 'react';

/**
 * Last-resort boundary for a failure in the root layout itself. It replaces the whole document, so it renders its
 * own <html>/<body> with inline styles (globals.css may not have loaded) and plain links instead of the app shell.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    heading.current?.focus();
    console.error('Root layout error', error.digest ?? error.name);
  }, [error]);

  return (
    <html lang="es">
      <body style={{ margin: 0, padding: '48px 16px', fontFamily: 'system-ui, sans-serif', background: '#f5f2e9', color: '#000' }}>
        <main style={{ maxWidth: 480, margin: '0 auto', display: 'grid', gap: 16 }}>
          <h1 ref={heading} tabIndex={-1} style={{ margin: 0, fontSize: 26 }}>
            Algo salió mal
          </h1>
          <p style={{ margin: 0 }}>La aplicación no pudo cargarse. Inténtalo de nuevo en unos segundos.</p>
          <p style={{ margin: 0, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={() => reset()}
              style={{ minHeight: 44, padding: '0 20px', borderRadius: 100, border: 0, background: '#000', color: '#f5f2e9', font: '700 14px system-ui, sans-serif', cursor: 'pointer' }}
            >
              Reintentar
            </button>
            {/* A full page load, not a client navigation: the app shell is what failed. */}
            <a href="/" style={{ display: 'inline-flex', alignItems: 'center', minHeight: 44, color: '#000', fontWeight: 700 }}>
              Ir al inicio
            </a>
          </p>
        </main>
      </body>
    </html>
  );
}
