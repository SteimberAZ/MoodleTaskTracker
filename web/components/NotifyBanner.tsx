'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { shouldShowPushBanner } from '@/lib/push';
import { CloseIcon } from './Icons';
import { usePushDevice } from './usePushDevice';

const KEY = 'push-banner-dismissed';

/**
 * "Activa las notificaciones en este dispositivo". Shown on the home page only when this device could use
 * Web Push (supported, or an iPhone outside the installed app) and has no active subscription.
 * Dismissing hides it for this browser session only, so it comes back until notifications are on.
 */
export default function NotifyBanner({ vapidPublicKey }: { vapidPublicKey?: string }) {
  const { snapshot } = usePushDevice(vapidPublicKey);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    try {
      if (sessionStorage.getItem(KEY) === '1') setDismissed(true);
    } catch {
      // Storage unavailable (private mode): the banner simply stays visible.
    }
  }, []);

  if (dismissed || !snapshot || !shouldShowPushBanner(snapshot.state)) return null;
  return (
    <aside className="banner" aria-label="Notificaciones">
      <div className="banner-text">
        <strong>Activa las notificaciones en este dispositivo</strong>
        <span>Recibe avisos de tus tareas aunque la app esté cerrada.</span>
      </div>
      <Link href="/notificaciones" className="btn primary">Activar</Link>
      <button
        type="button"
        className="icon-btn"
        aria-label="Ocultar aviso por ahora"
        onClick={() => {
          setDismissed(true);
          try {
            sessionStorage.setItem(KEY, '1');
          } catch {
            // Ignore: the dismissal just will not survive a reload.
          }
        }}
      >
        <CloseIcon />
      </button>
    </aside>
  );
}
