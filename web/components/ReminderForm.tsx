'use client';

import { useActionState } from 'react';
import Link from 'next/link';
import type { FormState } from '@/app/actions';
import type { ReminderFormInput } from '@/lib/validate';

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
}

export default function ReminderForm({ action, initial, submitLabel, tasks }: Props) {
  const [state, formAction, pending] = useActionState(action, {} as FormState);
  const v = state.values ?? initial;
  const e = state.errors ?? {};

  return (
    <form action={formAction} className="card form" noValidate>
      {state.error && <p className="alert" role="alert">{state.error}</p>}

      <label>
        Título
        <input name="title" defaultValue={v.title} maxLength={120} required />
        {e.title && <span className="field-error">{e.title}</span>}
      </label>

      <label>
        Mensaje (opcional)
        <textarea name="message" defaultValue={v.message} rows={3} maxLength={1000} />
        {e.message && <span className="field-error">{e.message}</span>}
      </label>

      <fieldset>
        <legend>Frecuencia (mínimo 5 minutos)</legend>
        <div className="row">
          <span className="prefix">Cada</span>
          <input name="amount" type="number" min={1} step={1} inputMode="numeric" defaultValue={v.amount} required />
          <select name="unit" defaultValue={v.unit} aria-label="Unidad">
            <option value="minutes">minutos</option>
            <option value="hours">horas</option>
            <option value="days">días</option>
          </select>
        </div>
        {(e.amount || e.unit) && <span className="field-error">{e.amount ?? e.unit}</span>}
      </fieldset>

      <label>
        Empieza (hora de Ecuador)
        <input name="startsAt" type="datetime-local" defaultValue={v.startsAt} required />
        {e.startsAt && <span className="field-error">{e.startsAt}</span>}
      </label>

      <label>
        Termina (hora de Ecuador)
        <input name="endsAt" type="datetime-local" defaultValue={v.endsAt} required />
        {e.endsAt && <span className="field-error">{e.endsAt}</span>}
      </label>

      <label>
        Relacionar con tarea (opcional)
        <select name="taskId" defaultValue={v.taskId}>
          <option value="">Sin tarea</option>
          {tasks.map((t) => (
            <option key={t.id} value={t.id}>
              {t.course ? `${t.title} — ${t.course}` : t.title}
            </option>
          ))}
        </select>
        {e.taskId && <span className="field-error">{e.taskId}</span>}
      </label>

      <div className="actions">
        <button type="submit" className="btn primary" disabled={pending}>
          {pending ? 'Guardando…' : submitLabel}
        </button>
        <Link href="/" className="btn">Cancelar</Link>
      </div>
    </form>
  );
}
