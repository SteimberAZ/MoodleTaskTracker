import type { ReactElement } from 'react';
import { automaticReminderSchedule, describeAutoReminder, type AutoReminderState, type SentMap } from '@/lib/auto-reminders';
import { hasDueDate } from '@/lib/task-time';
import { BellOffIcon, CheckIcon, ClockIcon, CloseIcon } from './Icons';

interface Props {
  dueTimestamp: number;
  nowSeconds: number;
  /** Milestones recorded by the worker; null when they could not be read. */
  sent: SentMap | null;
  submitted: boolean;
  muted: boolean;
}

const ICONS: Record<AutoReminderState, () => ReactElement> = {
  sent: CheckIcon,
  pending: ClockIcon,
  skipped: CloseIcon,
  stopped: BellOffIcon,
  unknown: ClockIcon,
};

/** Read-only schedule of the alerts the worker sends by itself. State is always spelled out in text, never color-only. */
export default function AutoRemindersCard({ dueTimestamp, nowSeconds, sent, submitted, muted }: Props) {
  const items = automaticReminderSchedule(dueTimestamp, nowSeconds, sent, { submitted, muted });
  const undated = !hasDueDate(dueTimestamp);

  return (
    <section className="card detail-card" aria-labelledby="auto-title">
      <h2 id="auto-title" className="card-title">Avisos automáticos</h2>
      <p>
        {undated
          ? 'Esta actividad no tiene fecha de entrega: solo recibes el aviso de tarea nueva.'
          : 'No necesitas configurar nada: te avisaremos antes de la entrega.'}
      </p>
      {submitted && <p className="muted">Entregada: avisos detenidos</p>}
      {!submitted && muted && (
        <p className="muted">Silenciada: no recibirás estos avisos. Usa «Activar» para volver a recibirlos.</p>
      )}
      <ul className="plain-list auto-list">
        {items.map((item) => {
          const StateIcon = ICONS[item.state];
          return (
            <li key={item.key} className={`auto-item auto-${item.state}`}>
              <span className="auto-icon">
                <StateIcon />
              </span>
              <span className="auto-label">{item.label}</span>
              <span className="auto-state">{describeAutoReminder(item)}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
