import type { Metadata } from 'next';
import Link from 'next/link';
import { withUser } from '@/lib/auth';
import { listRemindersPage, type ReminderWithTask } from '@/lib/reminders';
import { reminderStatus } from '@/lib/schedule';
import { pageCount, parsePage, remindersHref } from '@/lib/pagination';
import Pagination from '@/components/Pagination';
import ReminderCard from '@/components/ReminderCard';
import RemindersTabs from '@/components/RemindersTabs';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Recordatorios' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function RemindersPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const now = new Date();

  // Linked tasks come embedded in the same read (they may no longer be pending).
  const [, result] = await withUser((userId) => listRemindersPage(userId, parsePage(params.rp)).catch(() => null));
  const reminders: ReminderWithTask[] = result?.reminders ?? [];
  const page = result?.page ?? 1;
  const pages = pageCount(result?.total ?? 0);
  const saved = params.ok === 'saved';

  return (
    <>
      <RemindersTabs current="reminders" />
      <section
        aria-labelledby="reminders-title"
        className="section"
        data-status-id="reminder-status"
        data-fallback-id="reminders-title"
      >
        <div className="section-head">
          <h1 id="reminders-title" tabIndex={-1}>Recordatorios</h1>
          <Link href="/reminders/new" className="btn primary">Nuevo</Link>
        </div>
        <p className="muted section-intro">
          Tus tareas de Moodle ya tienen avisos automáticos. Usa los recordatorios para otras cosas o para que te insista más.
        </p>
        {/* Always mounted: delete results are announced here (text set by DeleteButton). */}
        <p id="reminder-status" role="status" className="sr-only" />
        {saved && (
          <p className="success" role="status">
            Recordatorio guardado
          </p>
        )}
        {!result && <p className="alert" role="alert">No se pudieron cargar los recordatorios.</p>}
        {result && reminders.length === 0 && (
          <p className="card muted empty">Aún no tienes recordatorios. Crea el primero con «Nuevo».</p>
        )}
        <ul className="list">
          {reminders.map((r) => (
            <ReminderCard
              key={r.id}
              reminder={r}
              status={reminderStatus(r, now)}
              hasTask={!!r.task_id}
              task={r.task}
            />
          ))}
        </ul>
        <Pagination page={page} pages={pages} label="Paginación de recordatorios" hrefFor={remindersHref} />
      </section>
      <section className="card item section" aria-labelledby="schedule-link-title">
        <h2 id="schedule-link-title" className="card-title">Horario de clases</h2>
        <p className="muted">Importa el PDF de tu horario del SGA y recibe un aviso antes de cada clase.</p>
        <div className="actions">
          <Link href="/horario" className="btn">Importar horario de clases</Link>
        </div>
      </section>
      <p className="muted small">Horas en Ecuador (UTC-5).</p>
    </>
  );
}
