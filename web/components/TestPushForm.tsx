'use client';

import { useActionState } from 'react';
import { sendTestNotification, type TestPushState } from '@/app/cuenta/actions';

/**
 * "Probar ntfy": publishes a test message to the user's ntfy topic (it does not test Web Push).
 * The result lives in an always-mounted status region (only its text changes), and the button stays
 * focusable while pending (aria-disabled plus a guard) instead of being disabled under the user's focus.
 */
export default function TestPushForm() {
  const [state, formAction, pending] = useActionState(sendTestNotification, {} as TestPushState);
  return (
    <form
      action={formAction}
      className="actions"
      onSubmit={(event) => {
        if (pending) event.preventDefault();
      }}
    >
      <button type="submit" className="btn" aria-disabled={pending || undefined}>
        {pending ? 'Enviando…' : 'Probar ntfy'}
      </button>
      <p className="muted small">No prueba las notificaciones Push.</p>
      <p role="status" className={state.ok === false ? 'field-error' : 'muted small'}>
        {state.message ?? ''}
      </p>
    </form>
  );
}
