'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { clearNotificationHistory, type ClearHistoryState } from '@/app/notificaciones/actions';
import LiveStatus from './LiveStatus';

/** "Borrar historial": asks for confirmation, then clears the session user's notification log. */
export default function ClearHistoryButton() {
  const [state, formAction, pending] = useActionState(clearNotificationHistory, {} as ClearHistoryState);
  const [announcement, setAnnouncement] = useState('');
  const wasPending = useRef(false);

  // The action answers {} on success, like the initial state: a finished submit without an error is the success.
  useEffect(() => {
    if (wasPending.current && !pending) setAnnouncement(state.error ? '' : 'Historial borrado');
    if (pending) setAnnouncement('');
    wasPending.current = pending;
  }, [pending, state]);

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
      <LiveStatus message={announcement} />
    </form>
  );
}
