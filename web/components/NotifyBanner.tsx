'use client';

import Link from 'next/link';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { shouldShowPushBanner } from '@/lib/push';
import { ACTIVATE_NOTIFICATIONS_HREF } from '@/lib/push-setup';
import { CloseIcon } from './Icons';
import { usePushDevice } from './usePushDevice';

const KEY = 'push-banner-dismissed';
/** CSS variable read by `body:has(.banner--toast) .container` to keep the page end clear of the toast. */
const HEIGHT_VAR = '--toast-h';

/** After the toast closes, focus would fall back to <body>: move it to the page heading instead. */
function focusMainHeading() {
  const heading = document.querySelector<HTMLElement>('#main h1') ?? document.getElementById('main');
  if (!heading) return;
  if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
  heading.focus({ preventScroll: true });
}

/**
 * "Activa las notificaciones en este dispositivo". Shown on the home page only when this device could use
 * Web Push (supported, or an iPhone outside the installed app) and has no active subscription.
 * Dismissing hides it for this browser session only, so it comes back until notifications are on.
 * It is a fixed toast above the tab bar (`.banner--toast`), so appearing after the device check never shifts the page.
 */
export default function NotifyBanner({ vapidPublicKey }: { vapidPublicKey?: string }) {
  const { snapshot } = usePushDevice(vapidPublicKey);
  const [dismissed, setDismissed] = useState(false);
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    try {
      if (sessionStorage.getItem(KEY) === '1') setDismissed(true);
    } catch {
      // Storage unavailable (private mode): the banner simply stays visible.
    }
  }, []);

  const visible = !dismissed && !!snapshot && shouldShowPushBanner(snapshot.state);

  // Publish the toast height so the page can pad its end while the toast covers it.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!visible || !el) return;
    const root = document.documentElement;
    const update = () => root.style.setProperty(HEIGHT_VAR, `${Math.ceil(el.getBoundingClientRect().height)}px`);
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(el);
    return () => {
      observer?.disconnect();
      root.style.removeProperty(HEIGHT_VAR);
    };
  }, [visible]);

  if (!visible) return null;
  return (
    <aside ref={ref} className="banner banner--toast" aria-label="Notificaciones">
      <div className="banner-text">
        <strong>Activa las notificaciones en este dispositivo</strong>
        <span>Recibe avisos de tus tareas aunque la app esté cerrada.</span>
      </div>
      <Link href={ACTIVATE_NOTIFICATIONS_HREF} className="btn primary">Activar</Link>
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
          focusMainHeading();
        }}
      >
        <CloseIcon />
      </button>
    </aside>
  );
}
