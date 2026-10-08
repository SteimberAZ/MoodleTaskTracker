import Link from 'next/link';
import type { MoodleTask } from '@/lib/tasks';
import { taskDetailHref, type HomeParams } from '@/lib/pagination';
import { safeHttpUrl } from '@/lib/task-detail';
import { moduleLabel } from '@/lib/task-module';
import { timeLeft } from '@/lib/task-time';
import { formatGuayaquilDue } from '@/lib/time';
import { ExternalIcon } from './Icons';
import MuteButton from './MuteButton';

interface Props {
  task: MoodleTask;
  nowSeconds: number;
  /** Task list state, carried to the detail link so "Volver" returns to the same page. */
  listState: HomeParams;
  /** Heading level of the title: 3 under a day heading ("Hoy", ...), 2 otherwise. */
  headingLevel?: 2 | 3;
  /** Shown in the "Atrasadas" tab: late-submission badge and a direct Moodle link. */
  overdue?: boolean;
}

/** Compact task card: title, course, due date with a relative badge, module chip and the actions. */
export default function TaskCard({ task, nowSeconds, listState, headingLevel = 2, overdue = false }: Props) {
  const muted = task.is_dismissed === 1;
  const submitted = task.status === 'submitted';
  const left = timeLeft(task.due_timestamp, nowSeconds);
  const urgent = !muted && !submitted && left.urgent;
  const badge = submitted
    ? { label: 'Entregada', tone: 'activo' }
    : overdue
      ? { label: 'Atrasada · Moodle puede aceptar entregas tardías', tone: 'urgente' }
      : { label: left.label, tone: urgent ? 'urgente' : 'pausado' };
  const Heading = headingLevel === 3 ? 'h3' : 'h2';
  const href = taskDetailHref(task.id, listState);
  const moodleUrl = overdue ? safeHttpUrl(task.task_url) : null;

  return (
    <li className={`card task-card${urgent ? ' urgent' : ''}${muted ? ' is-muted' : ''}`} data-card="">
      <div className="task-top">
        <span className="chip">{moduleLabel(task.module)}</span>
        {muted && <span className="chip chip-muted">Silenciada</span>}
        <span className={`badge ${badge.tone}`}>{badge.label}</span>
      </div>
      <Heading className="task-title">
        <Link href={href} title={task.title} data-card-focus="">
          {task.title}
        </Link>
      </Heading>
      {task.course && <p className="task-course" title={task.course}>{task.course}</p>}
      <p className="task-due">
        <span className="task-due-label">Vence</span>{' '}
        <time dateTime={new Date(task.due_timestamp * 1000).toISOString()}>
          {formatGuayaquilDue(task.due_timestamp, nowSeconds)}
        </time>
      </p>
      <div className="card-actions">
        {moodleUrl && (
          <a href={moodleUrl} target="_blank" rel="noopener noreferrer" className="btn primary">
            <span>Abrir en Moodle</span>
            <span className="sr-only"> (se abre en otra pestaña)</span>
            <ExternalIcon />
          </a>
        )}
        <Link href={href} className="btn">
          Ver detalle<span className="sr-only"> de {task.title}</span>
        </Link>
        <MuteButton taskId={task.id} muted={muted} title={task.title} />
      </div>
    </li>
  );
}
