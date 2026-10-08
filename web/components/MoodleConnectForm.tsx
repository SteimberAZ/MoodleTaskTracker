'use client';

import { useActionState } from 'react';
import { connectMoodle, type MoodleConnectState } from '@/app/actions';

/** The state never carries the password: only an error message or a success flag. */
export default function MoodleConnectForm({ reconnect }: { reconnect: boolean }) {
  const [state, formAction, pending] = useActionState(connectMoodle, {} as MoodleConnectState);

  return (
    <form action={formAction} className="card form" autoComplete="off">
      {state.error && <p className="alert" role="alert">{state.error}</p>}
      {state.connected && <p className="card muted" role="status">Moodle conectado correctamente.</p>}

      <label>
        Usuario de Moodle
        <input name="username" autoComplete="username" maxLength={100} required />
      </label>

      <label>
        Contraseña de Moodle
        <input name="password" type="password" autoComplete="off" maxLength={200} required />
      </label>

      <p className="muted small">La contraseña solo se usa para obtener un token y no se guarda.</p>

      <div className="actions">
        <button type="submit" className="btn primary" disabled={pending}>
          {pending ? 'Conectando…' : reconnect ? 'Volver a conectar' : 'Conectar'}
        </button>
      </div>
    </form>
  );
}
