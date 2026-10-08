'use client';

import { useActionState } from 'react';
import { login, type LoginState } from '@/app/login/actions';

/** The state never carries the password: only an error message and the non-secret fields. */
export default function LoginForm() {
  const [state, formAction, pending] = useActionState(login, {} as LoginState);
  return (
    <form action={formAction} className="card form narrow">
      <h1>Recordatorios</h1>
      <p className="muted small">Inicia sesión con tu cuenta de Moodle de la UTM.</p>
      {state.error && <p className="alert" role="alert">{state.error}</p>}

      <label>
        Usuario
        <input
          name="username"
          autoComplete="username"
          maxLength={100}
          defaultValue={state.username ?? ''}
          autoFocus
          required
        />
      </label>

      <label>
        Contraseña
        <input name="password" type="password" autoComplete="current-password" maxLength={200} required />
      </label>

      <details open={!!state.inviteCode}>
        <summary>Tengo un código de invitación</summary>
        <label>
          Código de invitación (solo la primera vez)
          <input
            name="inviteCode"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={40}
            defaultValue={state.inviteCode ?? ''}
          />
        </label>
      </details>

      <p className="muted small">La contraseña solo se usa para verificar tu cuenta en Moodle y no se guarda.</p>

      <button type="submit" className="btn primary" disabled={pending}>
        {pending ? 'Entrando…' : 'Entrar'}
      </button>
    </form>
  );
}
