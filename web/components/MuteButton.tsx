'use client';

import { useActionState, useEffect, useLayoutEffect, useRef } from 'react';
import { setTaskMute, type ActionResult } from '@/app/actions';
import { BellIcon, BellOffIcon } from './Icons';
import SubmitButton, { announceFrom, focusAfterRemoval } from './SubmitButton';

interface Props {
  taskId: string;
  /** Current state: true when the task is muted (is_dismissed = 1). */
  muted: boolean;
  /** Task title, used for the accessible name and the announcement. */
  title: string;
}

/** How long a successful submit may still be followed by the card leaving the list. */
const REMOVAL_GRACE_MS = 10_000;

/**
 * Mute / restore toggle. The form posts to the server action, so it still works without client JS. With JS
 * it shows a pending label, announces the result in the page's status region, keeps focus on failure and,
 * when the card leaves the list (muted from "Pendientes"), moves focus to the neighbouring card.
 */
export default function MuteButton({ taskId, muted, title }: Props) {
  const [state, formAction] = useActionState<ActionResult | null, FormData>(
    setTaskMute.bind(null, taskId, !muted),
    null,
  );
  const formRef = useRef<HTMLFormElement>(null);
  /** The submit in flight (or just finished): what it did and whether it was announced. */
  const intent = useRef<{ muted: boolean; announced: boolean; at: number } | null>(null);

  const message = (mutedNow: boolean) => (mutedNow ? `Tarea «${title}» silenciada` : `Avisos activados para «${title}»`);

  useEffect(() => {
    const current = intent.current;
    if (!state || !current) return;
    if (!state.ok) {
      intent.current = null;
      return;
    }
    if (!current.announced) {
      announceFrom(formRef.current, message(current.muted));
      current.announced = true;
    }
  }, [state]);

  // Runs while the card is still in the DOM when the revalidated list drops it.
  useLayoutEffect(() => {
    const form = formRef.current;
    return () => {
      const current = intent.current;
      if (!current || Date.now() - current.at > REMOVAL_GRACE_MS) return;
      if (!current.announced) announceFrom(form, message(current.muted));
      focusAfterRemoval(form);
    };
  }, []);

  return (
    <form
      ref={formRef}
      action={formAction}
      className="inline-form"
      onSubmit={() => {
        intent.current = { muted: !muted, announced: false, at: Date.now() };
      }}
    >
      <SubmitButton className="btn ghost" pendingLabel={muted ? 'Activando…' : 'Silenciando…'}>
        {muted ? <BellIcon /> : <BellOffIcon />}
        <span>{muted ? 'Activar' : 'Silenciar'}</span>
        <span className="sr-only">{muted ? ` avisos de «${title}»` : ` «${title}»`}</span>
      </SubmitButton>
      {state && !state.ok && (
        <p className="field-error" role="alert">
          {state.error ?? 'No se pudo actualizar la tarea.'}
        </p>
      )}
    </form>
  );
}
