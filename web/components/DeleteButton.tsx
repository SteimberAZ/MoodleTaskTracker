'use client';

import { useActionState, useEffect, useLayoutEffect, useRef } from 'react';
import type { ActionResult } from '@/app/actions';
import SubmitButton, { announceFrom, focusAfterRemoval } from './SubmitButton';

interface Props {
  /** Bound server action (`deleteReminder.bind(null, id)`). */
  action: () => Promise<ActionResult>;
  title: string;
}

const REMOVAL_GRACE_MS = 10_000;
const DELETED = 'Recordatorio eliminado';

/**
 * Asks for confirmation, then deletes. With JS it shows "Eliminando…", keeps focus and shows an alert on
 * failure, and when the card leaves the list moves focus to the neighbouring card and announces it.
 */
export default function DeleteButton({ action, title }: Props) {
  const [state, formAction] = useActionState<ActionResult | null, FormData>(action, null);
  const formRef = useRef<HTMLFormElement>(null);
  const intent = useRef<{ announced: boolean; at: number } | null>(null);

  useEffect(() => {
    const current = intent.current;
    if (!state || !current) return;
    if (!state.ok) {
      intent.current = null;
      return;
    }
    if (!current.announced) {
      announceFrom(formRef.current, DELETED);
      current.announced = true;
    }
  }, [state]);

  useLayoutEffect(() => {
    const form = formRef.current;
    return () => {
      const current = intent.current;
      if (!current || Date.now() - current.at > REMOVAL_GRACE_MS) return;
      if (!current.announced) announceFrom(form, DELETED);
      focusAfterRemoval(form);
    };
  }, []);

  return (
    <form
      ref={formRef}
      action={formAction}
      onSubmit={(event) => {
        if (!window.confirm(`¿Eliminar el recordatorio "${title}"? Esta acción no se puede deshacer.`)) {
          event.preventDefault();
          return;
        }
        intent.current = { announced: false, at: Date.now() };
      }}
    >
      <SubmitButton className="btn danger" pendingLabel="Eliminando…">
        Eliminar<span className="sr-only"> «{title}»</span>
      </SubmitButton>
      {state && !state.ok && (
        <p className="field-error" role="alert">
          {state.error ?? 'No se pudo eliminar el recordatorio.'}
        </p>
      )}
    </form>
  );
}
