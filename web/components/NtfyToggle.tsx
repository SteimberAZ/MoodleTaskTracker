'use client';

import { useActionState } from 'react';
import { setNtfyDelivery, type NtfyToggleState } from '@/app/cuenta/actions';

/** "Recibir también en la app ntfy": a switch bound to `moodle_users.ntfy_enabled`. */
export default function NtfyToggle({ enabled }: { enabled: boolean }) {
  const [state, formAction, pending] = useActionState(setNtfyDelivery, {} as NtfyToggleState);
  const current = state.enabled ?? enabled;

  return (
    <form action={formAction} className="switch-row">
      <input type="hidden" name="enabled" value={current ? 'false' : 'true'} />
      <button
        id="ntfy-switch"
        type="submit"
        role="switch"
        aria-checked={current}
        aria-labelledby="ntfy-switch-label"
        className="switch"
        disabled={pending}
      >
        <span className="switch-track" aria-hidden="true">
          <span className="switch-knob" />
        </span>
      </button>
      <label id="ntfy-switch-label" htmlFor="ntfy-switch" className="switch-label">Recibir también en la app ntfy</label>
      {state.error && <span className="field-error" role="alert">{state.error}</span>}
    </form>
  );
}
