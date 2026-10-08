'use client';

import { useActionState, type FormEvent } from 'react';
import {
  confirmNtfySubscription,
  regenerateTopic,
  setNtfyDelivery,
  type NtfyConfirmState,
  type NtfyToggleState,
  type RegenerateTopicState,
} from '@/app/cuenta/actions';

/**
 * Client controls of the ntfy card on /cuenta. Every control keeps an always-mounted status region (only its
 * text changes) and stays focusable while pending (aria-disabled plus a guard) instead of being disabled.
 */

const guard = (pending: boolean) => (event: FormEvent<HTMLFormElement>) => {
  if (pending) event.preventDefault();
};

/** "Recibir también en la app ntfy": a switch bound to `moodle_users.ntfy_enabled`. */
export default function NtfyToggle({ enabled }: { enabled: boolean }) {
  const [state, formAction, pending] = useActionState(setNtfyDelivery, {} as NtfyToggleState);
  const current = state.enabled ?? enabled;
  const message = state.error ?? state.warning ?? '';

  return (
    <form action={formAction} className="switch-row" onSubmit={guard(pending)}>
      <input type="hidden" name="enabled" value={current ? 'false' : 'true'} />
      <button
        id="ntfy-switch"
        type="submit"
        role="switch"
        aria-checked={current}
        aria-labelledby="ntfy-switch-label"
        aria-disabled={pending || undefined}
        className="switch"
      >
        <span className="switch-track" aria-hidden="true">
          <span className="switch-knob" />
        </span>
      </button>
      <label id="ntfy-switch-label" htmlFor="ntfy-switch" className="switch-label">Recibir también en la app ntfy</label>
      <span role="status" className={message ? 'field-error' : undefined}>
        {message}
      </span>
    </form>
  );
}

/**
 * Whether ntfy counts as delivered: only once the user confirmed it ("Probar ntfy" succeeded, or this
 * "Ya me suscribí en la app ntfy" button). Unconfirmed ntfy never masks a push failure.
 */
export function NtfyConfirm({ confirmedAt }: { confirmedAt: string | null }) {
  const [state, formAction, pending] = useActionState(confirmNtfySubscription, {} as NtfyConfirmState);
  // Only the server value: the action revalidates /cuenta, and a later "Regenerar tema" clears it, which a
  // remembered `state.confirmed` would otherwise keep showing as "Confirmado".
  const confirmed = !!confirmedAt;

  return (
    <form action={formAction} className="actions" onSubmit={guard(pending)}>
      <span className={`badge ${confirmed ? 'activo' : 'urgente'}`}>
        {confirmed ? 'Confirmado' : 'Sin confirmar: no cuenta como entregado'}
      </span>
      {!confirmed && (
        <button type="submit" className="btn" aria-disabled={pending || undefined}>
          {pending ? 'Guardando…' : 'Ya me suscribí en la app ntfy'}
        </button>
      )}
      <span role="status" className={state.error ? 'field-error' : 'sr-only'}>
        {state.error ?? (state.confirmed ? 'ntfy confirmado.' : '')}
      </span>
    </form>
  );
}

const REGENERATE_MESSAGE =
  '¿Regenerar tu tema? Dejarás de recibir avisos en el tema actual y tendrás que volver a suscribirte al nuevo.';

/** "Regenerar tema", with a confirmation and its result (or error) reported in place instead of throwing. */
export function RegenerateTopicForm() {
  const [state, formAction, pending] = useActionState(regenerateTopic, {} as RegenerateTopicState);
  return (
    <form
      action={formAction}
      className="actions"
      onSubmit={(event) => {
        if (pending || !window.confirm(REGENERATE_MESSAGE)) event.preventDefault();
      }}
    >
      <button type="submit" className="btn danger" aria-disabled={pending || undefined}>
        {pending ? 'Regenerando…' : 'Regenerar tema'}
      </button>
      <span role="status" className={state.error ? 'field-error' : 'muted small'}>
        {state.error ?? (state.ok ? 'Tema regenerado. Suscríbete al nuevo tema en la app ntfy.' : '')}
      </span>
    </form>
  );
}
