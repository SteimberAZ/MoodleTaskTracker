import Link from 'next/link';
import { logout, toggleReminder, deleteReminder } from './actions';
import { requireSession } from '@/lib/auth';
import { listReminders, type Reminder } from '@/lib/reminders';
import { formatInterval, reminderStatus, type ReminderStatus } from '@/lib/schedule';
import { formatGuayaquil } from '@/lib/time';
import { listPendingTasks, type MoodleTask } from '@/lib/tasks';
import { timeLeft } from '@/lib/task-time';
import DeleteButton from '@/components/DeleteButton';

export const dynamic = 'force-dynamic';

const ORDER: Record<ReminderStatus, number> = { activo: 0, pausado: 1, finalizado: 2 };

export default async function HomePage() {
  await requireSession();
  const now = new Date();
  let reminders: Reminder[] = [];
  let loadError = false;
  try {
    reminders = await listReminders();
  } catch {
    loadError = true;
  }

  const nowSeconds = Math.floor(now.getTime() / 1000);
  let tasks: MoodleTask[] = [];
  let tasksError = false;
  try {
    tasks = await listPendingTasks(nowSeconds);
  } catch {
    tasksError = true;
  }

  const rows = reminders
    .map((r) => ({ r, status: reminderStatus(r, now) }))
    .sort((a, b) => ORDER[a.status] - ORDER[b.status]);

  return (
    <>
      <header className="topbar">
        <h1>Recordatorios</h1>
        <div className="actions">
          <Link href="/reminders/new" className="btn primary">Nuevo</Link>
          <form action={logout}>
            <button type="submit" className="btn">Salir</button>
          </form>
        </div>
      </header>

      <section aria-labelledby="tasks-title" className="tasks">
        <h2 id="tasks-title" className="section-title">Tareas de Moodle pendientes</h2>
        {tasksError && (
          <p className="alert" role="alert">No se pudieron cargar las tareas de Moodle.</p>
        )}
        {!tasksError && tasks.length === 0 && (
          <p className="card muted">No tienes tareas pendientes 🎉</p>
        )}
        <ul className="list">
          {tasks.map((t) => {
            const left = timeLeft(t.due_timestamp, nowSeconds);
            const safeUrl = t.task_url && /^https?:\/\//i.test(t.task_url) ? t.task_url : null;
            return (
              <li key={t.id} className={`card item task${left.urgent ? ' urgent' : ''}`}>
                <div className="item-head">
                  <h3>{t.title}</h3>
                  <span className={`badge ${left.urgent ? 'urgente' : 'pausado'}`}>{left.label}</span>
                </div>
                {t.course && <p className="message">{t.course}</p>}
                <dl className="meta">
                  <div>
                    <dt>Vence</dt>
                    <dd>{formatGuayaquil(new Date(t.due_timestamp * 1000))}</dd>
                  </div>
                </dl>
                {safeUrl && (
                  <div className="actions">
                    <a href={safeUrl} target="_blank" rel="noopener noreferrer" className="btn">
                      Abrir en Moodle
                    </a>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <h2 className="section-title">Recordatorios</h2>
      {loadError && <p className="alert" role="alert">No se pudieron cargar los recordatorios.</p>}
      {!loadError && rows.length === 0 && (
        <p className="card muted">Aún no tienes recordatorios. Crea el primero con «Nuevo».</p>
      )}

      <ul className="list">
        {rows.map(({ r, status }) => (
          <li key={r.id} className={`card item ${status}`}>
            <div className="item-head">
              <h2>{r.title}</h2>
              <span className={`badge ${status}`}>{status}</span>
            </div>
            {r.message && <p className="message">{r.message}</p>}
            <dl className="meta">
              <div><dt>Frecuencia</dt><dd>{formatInterval(r.interval_minutes)}</dd></div>
              <div>
                <dt>Próximo aviso</dt>
                <dd>{status === 'activo' ? formatGuayaquil(r.next_fire_at) : '—'}</dd>
              </div>
              <div><dt>Hasta</dt><dd>{formatGuayaquil(r.ends_at)}</dd></div>
              <div><dt>Último envío</dt><dd>{formatGuayaquil(r.last_sent_at)}</dd></div>
            </dl>
            <div className="actions">
              {status !== 'finalizado' && (
                <form action={toggleReminder.bind(null, r.id)}>
                  <button type="submit" className="btn">{r.active ? 'Pausar' : 'Reanudar'}</button>
                </form>
              )}
              <Link href={`/reminders/${r.id}/edit`} className="btn">Editar</Link>
              <DeleteButton action={deleteReminder.bind(null, r.id)} title={r.title} />
            </div>
          </li>
        ))}
      </ul>
      <p className="muted small">Horas en Ecuador (UTC-5).</p>
    </>
  );
}
