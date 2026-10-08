'use client';

import { useActionState } from 'react';
import { setClassReminder, type LeadState } from '@/app/horario/actions';
import { CLASS_LEAD_OPTIONS, classNotification, leadLabel } from '@/lib/class-schedule';
import type { ScheduleClass } from '@/lib/sga-schedule';
import LiveStatus from './LiveStatus';

/** What the status region says after a saved change. */
export function leadSavedMessage(minutes: number | null): string {
  return minutes === null ? 'Avisos de clases desactivados' : `Aviso de clases: ${leadLabel(minutes)} antes guardado`;
}

/**
 * "Avisarme antes de cada clase": a segmented control bound to `moodle_users.class_reminder_minutes`, plus a preview
 * of the notification the worker sends (same formatting, see `classNotification`).
 * While a change is saving the buttons stay focusable (aria-disabled, not disabled, so focus is not lost) and a
 * second press is ignored; the saved value is announced through a persistent status region.
 */
export default function ClassReminderSetting({
  available,
  minutes,
  sample,
  sampleIsReal,
}: {
  available: boolean;
  minutes: number | null;
  sample: ScheduleClass;
  sampleIsReal: boolean;
}) {
  const [state, formAction, pending] = useActionState(setClassReminder, {} as LeadState);
  const current = state.minutes !== undefined ? state.minutes : minutes;

  if (!available) {
    return <p className="muted">No disponible todavía. Los avisos de clases se activarán cuando se complete la actualización.</p>;
  }

  const notification = current === null ? null : classNotification(sample, current);

  return (
    <div className="stack">
      <form
        action={formAction}
        className="stack"
        onSubmit={(event) => {
          if (pending) event.preventDefault();
        }}
      >
        <fieldset className="segmented" aria-disabled={pending || undefined}>
          <legend>Avisarme antes de cada clase</legend>
          <div className="segmented-row">
            {CLASS_LEAD_OPTIONS.map((option) => (
              <button
                key={option.token}
                type="submit"
                name="minutes"
                value={option.token}
                className="segment"
                aria-pressed={current === option.value}
                aria-disabled={pending || undefined}
              >
                {option.label}
              </button>
            ))}
          </div>
        </fieldset>
        {state.error && (
          <p className="field-error" role="alert">
            {state.error}
          </p>
        )}
        <LiveStatus message={!pending && !state.error && state.minutes !== undefined ? leadSavedMessage(state.minutes) : ''} />
      </form>
      {notification ? (
        <div>
          <p className="small muted">Así se verá el aviso{sampleIsReal ? ' (tu próxima clase)' : ' (ejemplo con datos ficticios)'}:</p>
          <div className="notif-preview" role="group" aria-label="Vista previa de la notificación">
            <p className="notif-title">{notification.title}</p>
            <p className="notif-body">{notification.body}</p>
          </div>
        </div>
      ) : (
        <p className="muted small">Los avisos están desactivados. Elige cuánto antes quieres recibirlos para ver cómo se verán.</p>
      )}
    </div>
  );
}
