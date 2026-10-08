'use client';

import { useRef } from 'react';
import { logout } from '@/app/actions';
import { pushLogoutCleanup } from '@/lib/push-client';
import { LogOutIcon } from './Icons';

/**
 * Logout control at the right end of the header. A POST form bound to the `logout` server action
 * (never a GET link, so a prefetch or a crawler cannot end the session).
 * Before the form posts, this device's push subscription is removed on the server (while the session cookie
 * is still valid) and unsubscribed locally, bounded to 1.5 s, so pushes stop reaching a device that logged out.
 * Phones: icon-only 44px button. Wide screens: icon plus the "Salir" text. The accessible name is "Salir" on both.
 */
export default function LogoutButton() {
  const cleaned = useRef(false);
  const running = useRef(false);

  return (
    <form
      action={logout}
      className="logout-form"
      onSubmit={(event) => {
        if (cleaned.current) return; // second pass: let the server action run
        event.preventDefault();
        if (running.current) return; // re-entry guard (double tap)
        running.current = true;
        const form = event.currentTarget;
        void pushLogoutCleanup(1500).finally(() => {
          cleaned.current = true;
          running.current = false;
          // Safari before 16 has no requestSubmit; clicking the submit button fires the same submit event.
          if (typeof form.requestSubmit === 'function') form.requestSubmit();
          else form.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
        });
      }}
    >
      <button type="submit" className="logout-btn" aria-label="Salir" title="Cerrar sesión">
        <LogOutIcon />
        <span className="logout-label" aria-hidden="true">Salir</span>
      </button>
    </form>
  );
}
