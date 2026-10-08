'use client';

import { useEffect } from 'react';
import { captureInstallPrompt, clearInstallPrompt, registerServiceWorker, resyncSubscription } from '@/lib/push-client';

/**
 * Mounted once in the root layout. Registers the service worker, keeps the "install app" prompt for
 * /notificaciones, and re-posts this device's push subscription (if any) on every app open.
 * Renders nothing.
 */
export default function PwaClient({ vapidPublicKey }: { vapidPublicKey?: string }) {
  useEffect(() => {
    const onPrompt = (event: Event) => {
      event.preventDefault(); // we offer our own "Instalar app" button instead of the mini-infobar
      captureInstallPrompt(event);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', clearInstallPrompt);

    let cancelled = false;
    void (async () => {
      const registration = await registerServiceWorker();
      if (registration && !cancelled) await resyncSubscription(vapidPublicKey);
    })();

    return () => {
      cancelled = true;
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', clearInstallPrompt);
    };
  }, [vapidPublicKey]);

  return null;
}
