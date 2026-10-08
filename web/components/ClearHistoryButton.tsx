'use client';

import { useActionState } from 'react';
import { clearNotificationHistory, type ClearHistoryState } from '@/app/notificaciones/actions';

/** "Borrar historial": asks for confirmation, then clears the session user's notification log. */
export default function ClearHistoryButton() {
  const [state, formAction, pending] = useActionState(clearNotificationHistory, {} as ClearHistoryState);
  return (
    <form
      action={formAction}
      className="hist-clear"
      onSubmit={(event) => {
        if (!window.confirm('¿Borrar todo tu historial de avisos? Esta acción no se puede deshacer.')) event.preventDefault();
      }}
    >
      <button type="submit" className="btn danger" disabled={pending}>
        {pending ? 'Borrando…' : 'Borrar historial'}
      </button>
      {state.error && <span className="field-error" role="alert">{state.error}</span>}
    </form>
  );
}
