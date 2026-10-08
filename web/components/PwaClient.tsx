'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';
import {
  captureInstallPrompt,
  clearInstallPrompt,
  openUrlTarget,
  registerServiceWorker,
  resyncSubscription,
  trackResync,
} from '@/lib/push-client';

const LOGIN_PATH = '/login';

/**
 * Mounted once in the root layout. Registers the service worker, keeps the "install app" prompt for
 * /notificaciones, re-posts this device's push subscription (if any) once per session (on the first app page,
 * and again after a login redirect), and lets a tapped notification navigate in place instead of reloading.
 * Renders nothing.
 */
export default function PwaClient({ vapidPublicKey }: { vapidPublicKey?: string }) {
  const pathname = usePathname();
  const router = useRouter();
  // True until the subscription was re-posted from an app page; reset by visiting /login (new session).
  const needsSync = useRef(true);

  useEffect(() => {
    const onPrompt = (event: Event) => {
      event.preventDefault(); // we offer our own "Instalar app" button instead of the mini-infobar
      captureInstallPrompt(event);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', clearInstallPrompt);
    void registerServiceWorker();
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', clearInstallPrompt);
    };
  }, []);

  useEffect(() => {
    if (pathname === LOGIN_PATH) {
      needsSync.current = true;
      return;
    }
    if (!needsSync.current) return;
    needsSync.current = false;
    // Tracked: the device card and the push banner wait for it, then read the repaired state again.
    void trackResync(
      (async () => {
        const registration = await registerServiceWorker();
        if (registration) await resyncSubscription(vapidPublicKey);
      })(),
    );
  }, [pathname, vapidPublicKey]);

  // The service worker asks an open page to show a tapped notification's page: acknowledge, then route client-side.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const container = navigator.serviceWorker;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; url?: unknown } | null;
      if (!data || data.type !== 'open-url') return;
      const target = openUrlTarget(data.url, window.location.origin);
      if (!target) return; // no ack: the service worker falls back to a full navigation
      event.ports?.[0]?.postMessage({ ok: true });
      if (target === `${window.location.pathname}${window.location.search}`) router.refresh();
      else router.push(target);
    };
    container.addEventListener('message', onMessage);
    return () => container.removeEventListener('message', onMessage);
  }, [router]);

  return null;
}
