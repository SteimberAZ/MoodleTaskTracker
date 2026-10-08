import Link from 'next/link';
import { deleteReminder, toggleReminder } from '@/app/actions';
import type { Reminder } from '@/lib/reminders';
import { formatInterval, type ReminderStatus } from '@/lib/schedule';
import { taskDetailHref } from '@/lib/pagination';
import { formatGuayaquil } from '@/lib/time';
import DeleteButton from './DeleteButton';

interface Props {
  reminder: Reminder;
  status: ReminderStatus;
  /** Title of the linked task, when the reminder has one (null = the task no longer exists). */
  task?: { id: string; title: string } | null;
  hasTask: boolean;
}

/** Compact reminder card: title and status, frequency and next notice on one meta line, three actions. */
export default function ReminderCard({ reminder: r, status, task, hasTask }: Props) {
  return (
    <li className={`card reminder-card ${status}`}>
      <div className="task-top">
        <span className={`badge ${status}`}>{status}</span>
      </div>
      <h3 className="task-title" title={r.title}>{r.title}</h3>
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
          <form action={toggleReminder.bind(null, r.id)} className="inline-form">
            <button type="submit" className="btn">{r.active ? 'Pausar' : 'Reanudar'}</button>
          </form>
        )}
        <Link href={`/reminders/${r.id}/edit`} className="btn">Editar</Link>
        <DeleteButton action={deleteReminder.bind(null, r.id)} title={r.title} />
      </div>
    </li>
  );
}
