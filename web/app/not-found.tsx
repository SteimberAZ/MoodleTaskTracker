'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';

/**
 * 404 screen for unknown routes and for `notFound()` (e.g. a task that was deleted or belongs to someone else).
 * A client component only so the heading can take focus, like the error screen.
 */
export default function NotFound() {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);

  return (
    <section className="card item error-screen" aria-labelledby="not-found-title">
      <h1 id="not-found-title" ref={heading} tabIndex={-1}>
        Esta página o tarea ya no existe
      </h1>
      <p className="muted">Puede que el enlace sea antiguo o que la tarea se haya eliminado de Moodle.</p>
      <div className="actions">
        <Link href="/" className="btn primary">
          Volver a Tareas
        </Link>
      </div>
    </section>
  );
}
