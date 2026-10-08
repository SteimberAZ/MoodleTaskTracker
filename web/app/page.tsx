import Link from 'next/link';
import { logout, toggleReminder, deleteReminder } from './actions';
import { requireSession } from '@/lib/auth';
import { listReminders, type Reminder } from '@/lib/reminders';
import { formatInterval, reminderStatus, type ReminderStatus } from '@/lib/schedule';
import { formatGuayaquil } from '@/lib/time';
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
