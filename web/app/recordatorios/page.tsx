import Link from 'next/link';
import { requireUser } from '@/lib/auth';
import { listRemindersPage, type Reminder } from '@/lib/reminders';
import { reminderStatus } from '@/lib/schedule';
import { listTasksByIds, type MoodleTask } from '@/lib/tasks';
import { pageCount, parsePage, remindersHref } from '@/lib/pagination';
import Pagination from '@/components/Pagination';
import ReminderCard from '@/components/ReminderCard';

export const dynamic = 'force-dynamic';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function RemindersPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const params = await searchParams;
  const now = new Date();

  const result = await listRemindersPage(user.id, parsePage(params.rp)).catch(() => null);
  const reminders: Reminder[] = result?.reminders ?? [];
  const page = result?.page ?? 1;
  const pages = pageCount(result?.total ?? 0);

  // Linked tasks may no longer be pending, so resolve them by id.
  const linkedIds = reminders.map((r) => r.task_id).filter((id): id is string => !!id);
  const linked = new Map<string, MoodleTask>(
    (await listTasksByIds(user.id, linkedIds).catch(() => [])).map((t) => [t.id, t]),
  );

  return (
    <>
      <section aria-labelledby="reminders-title" className="section">
        <div className="section-head">
          <h1 id="reminders-title">Recordatorios</h1>
          <Link href="/reminders/new" className="btn primary">Nuevo</Link>
        </div>
        <p className="muted section-intro">
          Tus tareas de Moodle ya tienen avisos automáticos. Usa los recordatorios para otras cosas o para que te insista más.
        </p>
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
              task={r.task_id ? (linked.get(r.task_id) ?? null) : null}
            />
          ))}
        </ul>
        <Pagination page={page} pages={pages} label="Paginación de recordatorios" hrefFor={remindersHref} />
      </section>
      <p className="muted small">Horas en Ecuador (UTC-5).</p>
    </>
  );
}
