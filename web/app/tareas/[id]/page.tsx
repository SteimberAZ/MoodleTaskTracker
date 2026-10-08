import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { withUser } from '@/lib/auth';
import { getSessionUserId } from '@/lib/session';
import { getTaskDetail } from '@/lib/tasks';
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

/** Tab title: the task title through the request-cached read the page reuses. Never throws. */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  try {
    const [{ id }, userId] = await Promise.all([params, getSessionUserId()]);
    const task = userId ? await getTaskDetail(userId, id) : null;
    return { title: task?.title || 'Tarea' };
  } catch {
    return { title: 'Tarea' };
  }
}

export default async function TaskDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SearchParams;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  // Owner-scoped read (milestones embedded): a task of another user is indistinguishable from a missing one.
  const [, task] = await withUser((userId) => getTaskDetail(userId, id));
  if (!task) notFound();

  const sent = task.milestones;
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
    <article className="detail" data-status-id="task-status">
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

      {/* Always mounted: mute results are announced here (text set by MuteButton). */}
      <p id="task-status" role="status" className="sr-only" />
      <div className="detail-actions">
        {moodleUrl && (
          <a href={moodleUrl} target="_blank" rel="noopener noreferrer" className="btn primary">
            <span>Abrir en Moodle</span>
            <span className="sr-only"> (se abre en otra pestaña)</span>
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
