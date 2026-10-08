'use client';

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { useFormStatus } from 'react-dom';

interface Props extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  children: ReactNode;
  /** Shown instead of `children` while the form is being submitted ("Eliminando…"). */
  pendingLabel?: ReactNode;
}

/**
 * Submit button of a server-action form. While the form is pending it is `aria-disabled` and `aria-busy`
 * and ignores further clicks. It is deliberately not `disabled` while pending: disabling the focused
 * control makes browsers drop focus to <body>. The `disabled` prop still disables it for real.
 */
export default function SubmitButton({ children, pendingLabel, className, onClick, ...rest }: Props) {
  const { pending } = useFormStatus();
  return (
    <button
      {...rest}
      type="submit"
      className={className}
      aria-disabled={pending || rest['aria-disabled'] || undefined}
      aria-busy={pending || undefined}
      onClick={(event) => {
        if (pending) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
    >
      {pending && pendingLabel ? pendingLabel : children}
    </button>
  );
}

/**
 * Writes a message into the always-mounted live region named by the closest `[data-status-id]` scope.
 * The text is cleared first so the same message is announced again.
 */
export function announceFrom(from: Element | null, message: string): void {
  const id = from?.closest<HTMLElement>('[data-status-id]')?.dataset.statusId;
  const region = id ? document.getElementById(id) : null;
  if (!region) return;
  region.textContent = '';
  window.setTimeout(() => {
    region.textContent = message;
  }, 50);
}

/**
 * Moves focus off a card that is about to be removed: to the next card's `[data-card-focus]` element, else
 * the previous one, else the scope's fallback heading (`data-fallback-id`, which must have tabIndex=-1).
 * Call it while the card is still in the DOM (a layout-effect cleanup). Only acts when focus is inside the
 * card or already lost, so it never steals focus from elsewhere.
 */
export function focusAfterRemoval(from: Element | null): void {
  const card = from?.closest('[data-card]');
  const scope = from?.closest<HTMLElement>('[data-fallback-id]');
  if (!card || !scope) return;
  const active = document.activeElement;
  if (active && active !== document.body && !card.contains(active)) return;

  const fallbackId = scope.dataset.fallbackId!;
  const targets = Array.from(scope.querySelectorAll<HTMLElement>('[data-card-focus]'));
  const own = targets.findIndex((el) => card.contains(el));
  const others = targets.filter((el) => !card.contains(el));
  const next = own >= 0 ? (targets.slice(own + 1).find((el) => !card.contains(el)) ?? others[others.length - 1]) : others[0];
  (next ?? document.getElementById(fallbackId))?.focus();

  // The neighbour may be replaced in the same update (page change): never leave focus on <body>.
  window.requestAnimationFrame(() => {
    const now = document.activeElement;
    if (!now || now === document.body || !now.isConnected) document.getElementById(fallbackId)?.focus();
  });
}
