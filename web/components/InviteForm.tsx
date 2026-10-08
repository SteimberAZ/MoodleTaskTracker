'use client';

import { useActionState } from 'react';
import { createInviteAction, type InviteFormState } from '@/app/admin/actions';
import LiveStatus from './LiveStatus';

export default function InviteForm() {
  const [state, formAction, pending] = useActionState(createInviteAction, {} as InviteFormState);
  return (
    <form action={formAction} className="card form">
      {state.error && <p className="alert" role="alert">{state.error}</p>}
      {state.created && (
        <p className="muted">
          Invitación creada: <strong className="mono">{state.created}</strong>
        </p>
      )}
      {/* Announced through the persistent region: a status role added together with its text is often missed. */}
      <LiveStatus message={state.created ? `Invitación creada: ${state.created}` : ''} />
      <label>
        Vigencia en días (opcional)
        <input name="days" type="number" inputMode="numeric" min={1} max={365} step={1} placeholder="Sin vencimiento" />
      </label>
      <div className="actions">
        <button type="submit" className="btn primary" disabled={pending}>
          {pending ? 'Creando…' : 'Crear invitación'}
        </button>
      </div>
    </form>
  );
}
