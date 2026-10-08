'use client';

import { useEffect } from 'react';

/**
 * Brings the notification the user tapped into view and moves focus to it (screen readers announce it).
 * Renders nothing. Smooth scrolling is skipped when the user prefers reduced motion.
 */
export default function ScrollToNotification({ targetId, focusKey }: { targetId: string; focusKey: string }) {
  useEffect(() => {
    const el = document.getElementById(targetId);
    if (!el) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
    el.focus({ preventScroll: true });
  }, [targetId, focusKey]);
  return null;
}
