import Link from 'next/link';
import { deleteReminder, setReminderActive } from '@/app/actions';
import type { Reminder } from '@/lib/reminders';
import { formatInterval, type ReminderStatus } from '@/lib/schedule';
import { taskDetailHref } from '@/lib/pagination';
import { formatGuayaquil } from '@/lib/time';
import DeleteButton from './DeleteButton';
import SubmitButton from './SubmitButton';

interface Props {
  reminder: Reminder;
  status: ReminderStatus;
  /** The linked task, when the reminder has one (null = the task no longer exists or is not readable). */
  task?: { id: string; title: string; status?: string } | null;
  hasTask: boolean;
}

/** Badge text: a paused reminder whose task was submitted was stopped for that reason, not by the user. */
export function reminderBadgeLabel(
  status: ReminderStatus,
  reminder: Pick<Reminder, 'active'>,
  task: { status?: string } | null | undefined,
): string {
  if (!reminder.active && task?.status === 'submitted') return 'Detenido: tarea entregada';
  return status;
}

/** Compact reminder card: title and status, frequency and next notice on one meta line, three actions. */
export default function ReminderCard({ reminder: r, status, task, hasTask }: Props) {
  return (
    <li className={`card reminder-card ${status}`} data-card="">
      <div className="task-top">
        <span className={`badge ${status}`}>{reminderBadgeLabel(status, r, task)}</span>
      </div>
      <h2 className="task-title" title={r.title} tabIndex={-1} data-card-focus="">
        {r.title}
      </h2>
      {r.message && <p className="task-course" title={r.message}>{r.message}</p>}
      {hasTask && (
        <p className="task-course">
          Tarea:{' '}
          {task ? <Link href={taskDetailHref(task.id, {})} className="link">{task.title}</Link> : 'no disponible'}
        </p>
      )}
      <p className="task-due">
        <span className="task-due-label">{formatInterval(r.interval_minutes)}</span>
        {' · '}
        {status === 'activo' ? <>próximo {formatGuayaquil(r.next_fire_at)}</> : <>hasta {formatGuayaquil(r.ends_at)}</>}
      </p>
      <div className="card-actions">
        {status !== 'finalizado' && (
          <form action={setReminderActive.bind(null, r.id, !r.active)} className="inline-form">
            <SubmitButton className="btn" pendingLabel={r.active ? 'Pausando…' : 'Reanudando…'}>
              {r.active ? 'Pausar' : 'Reanudar'}
              <span className="sr-only"> «{r.title}»</span>
            </SubmitButton>
          </form>
        )}
        <Link href={`/reminders/${r.id}/edit`} className="btn">
          Editar<span className="sr-only"> «{r.title}»</span>
        </Link>
        <DeleteButton action={deleteReminder.bind(null, r.id)} title={r.title} />
      </div>
    </li>
  );
}
