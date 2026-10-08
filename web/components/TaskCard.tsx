import Link from 'next/link';
import type { MoodleTask } from '@/lib/tasks';
import { taskDetailHref, type HomeParams } from '@/lib/pagination';
import { moduleLabel } from '@/lib/task-module';
import { timeLeft } from '@/lib/task-time';
import { formatGuayaquil } from '@/lib/time';
import MuteButton from './MuteButton';

interface Props {
  task: MoodleTask;
  nowSeconds: number;
  /** Task list state, carried to the detail link so "Volver" returns to the same page. */
  listState: HomeParams;
}

/** Compact one-line task card: title, course, due date with a relative badge, module chip and two actions. */
export default function TaskCard({ task, nowSeconds, listState }: Props) {
  const muted = task.is_dismissed === 1;
  const submitted = task.status === 'submitted';
  const left = timeLeft(task.due_timestamp, nowSeconds);
  const urgent = !muted && !submitted && left.urgent;
  const badge = submitted
    ? { label: 'Entregada', tone: 'activo' }
    : { label: left.label, tone: urgent ? 'urgente' : 'pausado' };

  return (
    <li className={`card task-card${urgent ? ' urgent' : ''}${muted ? ' is-muted' : ''}`}>
      <div className="task-top">
        <span className="chip">{moduleLabel(task.module)}</span>
        {muted && <span className="chip chip-muted">Silenciada</span>}
        <span className={`badge ${badge.tone}`}>{badge.label}</span>
      </div>
      <h3 className="task-title">
        <Link href={taskDetailHref(task.id, listState)} title={task.title}>
          {task.title}
        </Link>
      </h3>
      {task.course && <p className="task-course" title={task.course}>{task.course}</p>}
      <p className="task-due">
        <span className="task-due-label">Vence</span>{' '}
        <time dateTime={new Date(task.due_timestamp * 1000).toISOString()}>
          {formatGuayaquil(new Date(task.due_timestamp * 1000))}
        </time>
      </p>
      <div className="card-actions">
        <Link href={taskDetailHref(task.id, listState)} className="btn">
          Ver detalle
        </Link>
        <MuteButton taskId={task.id} muted={muted} title={task.title} />
      </div>
    </li>
  );
}
