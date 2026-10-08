'use client';

import { useActionState } from 'react';
import { sendTestNotification, type TestPushState } from '@/app/cuenta/actions';

export default function TestPushForm() {
  const [state, formAction, pending] = useActionState(sendTestNotification, {} as TestPushState);
  return (
    <form action={formAction} className="actions">
      <button type="submit" className="btn" disabled={pending}>
        {pending ? 'Enviando…' : 'Enviar notificación de prueba'}
      </button>
      {state.message && (
        <p className={state.ok ? 'muted small' : 'field-error'} role={state.ok ? 'status' : 'alert'}>
          {state.message}
        </p>
      )}
    </form>
  );
}
