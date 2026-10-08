'use client';

import { useActionState } from 'react';
import { login, type LoginState } from '@/app/actions';

export default function LoginForm() {
  const [state, formAction, pending] = useActionState(login, {} as LoginState);
  return (
    <form action={formAction} className="card form narrow">
      <h1>Recordatorios</h1>
      {state.error && <p className="alert" role="alert">{state.error}</p>}
      <label>
        Contraseña
        <input name="password" type="password" autoComplete="current-password" autoFocus required />
      </label>
      <button type="submit" className="btn primary" disabled={pending}>
        {pending ? 'Entrando…' : 'Entrar'}
      </button>
    </form>
  );
}
