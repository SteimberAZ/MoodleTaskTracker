import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/auth';
import { getTaskDetail, getTaskMilestones } from '@/lib/tasks';
import { homeHref, parsePage } from '@/lib/pagination';
import { normalizeDescription, normalizeTeachers, safeHttpUrl } from '@/lib/task-detail';
import { moduleLabel } from '@/lib/task-module';
import { parseTaskFilter } from '@/lib/task-query';
import { timeLeft } from '@/lib/task-time';
import { formatGuayaquil } from '@/lib/time';
import { ChevronLeftIcon, ExternalIcon } from '@/components/Icons';
import AutoRemindersCard from '@/components/AutoRemindersCard';
import MuteButton from '@/components/MuteButton';

export const dynamic = 'force-dynamic';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function TaskDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SearchParams;
}) {
  const user = await requireUser();
  const { id } = await params;
  const query = await searchParams;
  // Owner-scoped read: a task of another user is indistinguishable from a missing one.
  const task = await getTaskDetail(user.id, id);
  if (!task) notFound();

  // Only after the owner-scoped read above: the milestones table has no owner column.
  const sent = await getTaskMilestones(task);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const muted = task.is_dismissed === 1;
  const submitted = task.status === 'submitted';
  const left = timeLeft(task.due_timestamp, nowSeconds);
  const teachers = normalizeTeachers(task.teachers);
  const description = normalizeDescription(task.description);
  const moodleUrl = safeHttpUrl(task.task_url);
  const back = homeHref(
    { tf: parseTaskFilter(query.tf), tp: parsePage(query.tp) },
    'tareas',
  );

  return (
    <article className="detail">
      <Link href={back} className="back-link">
        <ChevronLeftIcon />
        <span>Volver a mis tareas</span>
      </Link>

      <header className="detail-head">
        <div className="task-top">
          <span className="chip">{moduleLabel(task.module)}</span>
          {muted && <span className="chip chip-muted">Silenciada</span>}
        </div>
        <h1 className="detail-title">{task.title}</h1>
        {task.course && <p className="muted">{task.course}</p>}
      </header>

      <section className="card detail-card" aria-label="Datos de la tarea">
        <dl className="meta">
          <div>
            <dt>Vence</dt>
            <dd>
              {formatGuayaquil(new Date(task.due_timestamp * 1000))}
              {!submitted && (
                <span className={`badge ${!muted && left.urgent ? 'urgente' : 'pausado'}`}>{left.label}</span>
              )}
            </dd>
          </div>
          <div>
            <dt>Estado</dt>
            <dd>{submitted ? 'Entregada' : 'Pendiente'}</dd>
          </div>
          <div>
            <dt>Profesor(es)</dt>
            <dd>
              {teachers.length > 0 ? (
                <ul className="plain-list">
                  {teachers.map((name) => (
                    <li key={name}>{name}</li>
                  ))}
                </ul>
              ) : (
                <span className="muted">No disponible</span>
              )}
            </dd>
          </div>
        </dl>
      </section>

      <section className="card detail-card" aria-labelledby="desc-title">
        <h2 id="desc-title" className="card-title">Descripción</h2>
        {description ? (
          // Plain text only: line breaks are preserved with CSS, never rendered as HTML.
          <p className="description">{description}</p>
        ) : (
          <p className="muted">No disponible</p>
        )}
      </section>

      <AutoRemindersCard
        dueTimestamp={task.due_timestamp}
        nowSeconds={nowSeconds}
        sent={sent}
        submitted={submitted}
        muted={muted}
      />

      <div className="detail-actions">
        {moodleUrl && (
          <a href={moodleUrl} target="_blank" rel="noopener noreferrer" className="btn primary">
            <span>Abrir en Moodle</span>
            <ExternalIcon />
          </a>
        )}
        <MuteButton taskId={task.id} muted={muted} title={task.title} />
      </div>
      <div className="extra-reminder">
        <Link href={`/reminders/new?task=${encodeURIComponent(task.id)}`} className="btn ghost">
          Recordarme más seguido
        </Link>
        <p className="muted small">Opcional: un recordatorio extra que se repite cada cierto tiempo</p>
      </div>
      <p className="muted small">Horas en Ecuador (UTC-5).</p>
    </article>
  );
}
