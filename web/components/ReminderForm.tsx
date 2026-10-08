'use client';

import { useActionState, useEffect, useRef } from 'react';
import Link from 'next/link';
import type { FormState } from '@/app/actions';
import { REMINDERS_PATH } from '@/lib/nav';
import type { FieldErrors, ReminderFormInput } from '@/lib/validate';

export interface TaskOption {
  id: string;
  title: string;
  course: string | null;
}

interface Props {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  initial: ReminderFormInput;
  submitLabel: string;
  tasks: TaskOption[];
  /** Starting action state (tests render the error state with it); defaults to an empty state. */
  initialState?: FormState;
}

type Field = keyof ReminderFormInput;

/** Fields in document order: the first invalid one receives focus after a failed submit. */
const FIELD_ORDER: Field[] = ['title', 'message', 'amount', 'unit', 'startsAt', 'endsAt', 'taskId'];

const fieldId = (field: Field): string => `rf-${field}`;
/** Amount and unit share one message under the frequency row. */
const errorId = (field: Field): string => `${fieldId(field === 'unit' ? 'amount' : field)}-error`;

/** Number of messages shown: the frequency row counts once even when both amount and unit failed. */
export function countFieldErrors(errors: FieldErrors): number {
  return FIELD_ORDER.filter((f) => errors[f] && !(f === 'unit' && errors.amount)).length;
}

const EMPTY_STATE: FormState = {};

export default function ReminderForm({ action, initial, submitLabel, tasks, initialState = EMPTY_STATE }: Props) {
  const [state, formAction, pending] = useActionState(action, initialState);
  const v = state.values ?? initial;
  const e = state.errors ?? {};
  const errorCount = countFieldErrors(e);
  const alertRef = useRef<HTMLParagraphElement>(null);

  // After each submit: focus the first invalid field (document order), or the top alert for a general error,
  // so keyboard and screen reader users (and phones, where the alert may be off screen) land on the problem.
  useEffect(() => {
    const errors = state.errors ?? {};
    const first = FIELD_ORDER.find((f) => errors[f]);
    if (first) {
      document.getElementById(fieldId(first === 'unit' && errors.amount ? 'amount' : first))?.focus();
    } else if (state.error) {
      alertRef.current?.focus();
    }
  }, [state]);

  /** aria-invalid / aria-describedby for one control. */
  const invalid = (field: Field, failed = !!e[field]) =>
    failed ? { 'aria-invalid': true as const, 'aria-describedby': errorId(field) } : {};
  const message = (field: Field, text: string | undefined) =>
    text ? (
      <span id={errorId(field)} className="field-error">
        {text}
      </span>
    ) : null;
  const frequencyFailed = !!(e.amount || e.unit);

  return (
    <form action={formAction} className="card form" noValidate>
      {state.error && (
        <p className="alert" role="alert" tabIndex={-1} ref={alertRef}>
          {state.error}
        </p>
      )}
      {errorCount > 0 && (
        <p className="alert" role="alert">
          Revisa {errorCount} {errorCount === 1 ? 'campo' : 'campos'}.
        </p>
      )}

      <div className="field">
        <label htmlFor="rf-title">Título</label>
        <input id="rf-title" name="title" defaultValue={v.title} maxLength={120} required {...invalid('title')} />
        {message('title', e.title)}
      </div>

      <div className="field">
        <label htmlFor="rf-message">Mensaje (opcional)</label>
        <textarea id="rf-message" name="message" defaultValue={v.message} rows={3} maxLength={1000} {...invalid('message')} />
        {message('message', e.message)}
      </div>

      <fieldset>
        <legend id="rf-frequency-legend">Frecuencia (mínimo 5 minutos)</legend>
        <div className="row">
          <span className="prefix" id="rf-amount-prefix">
            Cada
          </span>
          <input
            id="rf-amount"
            name="amount"
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            defaultValue={v.amount}
            required
            aria-labelledby="rf-frequency-legend rf-amount-prefix"
            {...invalid('amount', frequencyFailed)}
          />
          <select id="rf-unit" name="unit" defaultValue={v.unit} aria-label="Unidad" {...invalid('unit', frequencyFailed)}>
            <option value="minutes">minutos</option>
            <option value="hours">horas</option>
            <option value="days">días</option>
          </select>
        </div>
        {message('amount', e.amount ?? e.unit)}
      </fieldset>

      <div className="field">
        <label htmlFor="rf-startsAt">Empieza (hora de Ecuador)</label>
        <input id="rf-startsAt" name="startsAt" type="datetime-local" defaultValue={v.startsAt} required {...invalid('startsAt')} />
        {message('startsAt', e.startsAt)}
      </div>

      <div className="field">
        <label htmlFor="rf-endsAt">Termina (hora de Ecuador)</label>
        <input id="rf-endsAt" name="endsAt" type="datetime-local" defaultValue={v.endsAt} required {...invalid('endsAt')} />
        {message('endsAt', e.endsAt)}
      </div>

      <div className="field">
        <label htmlFor="rf-taskId">Relacionar con tarea (opcional)</label>
        <select id="rf-taskId" name="taskId" defaultValue={v.taskId} {...invalid('taskId')}>
          <option value="">Sin tarea</option>
          {tasks.map((t) => (
            <option key={t.id} value={t.id}>
              {t.course ? `${t.title} — ${t.course}` : t.title}
            </option>
          ))}
        </select>
        {message('taskId', e.taskId)}
      </div>

      <div className="actions">
        <button type="submit" className="btn primary" disabled={pending}>
          {pending ? 'Guardando…' : submitLabel}
        </button>
        <Link href={REMINDERS_PATH} className="btn">Cancelar</Link>
      </div>
    </form>
  );
}
