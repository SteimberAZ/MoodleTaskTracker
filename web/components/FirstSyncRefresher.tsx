'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

const EVERY_MS = 15_000;
const STOP_AFTER_MS = 3 * 60_000;

/**
 * Mounted only while the first sync is pending: re-renders the server page every 15 s so the tasks appear
 * as soon as the worker stores them, and gives up after 3 minutes.
 */
export default function FirstSyncRefresher() {
  const router = useRouter();
  useEffect(() => {
    const started = Date.now();
    const timer = window.setInterval(() => {
      if (Date.now() - started >= STOP_AFTER_MS) {
        window.clearInterval(timer);
        return;
      }
      if (document.visibilityState === 'visible') router.refresh();
    }, EVERY_MS);
    return () => window.clearInterval(timer);
  }, [router]);
  return null;
}
