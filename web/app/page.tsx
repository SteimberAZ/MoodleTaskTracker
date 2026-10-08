import Link from 'next/link';
import { requireUser } from '@/lib/auth';
import { listRemindersPage, type Reminder } from '@/lib/reminders';
import { reminderStatus } from '@/lib/schedule';
import { countTasks, listTasksByIds, listTasksPage, type MoodleTask } from '@/lib/tasks';
import { homeHref, pageCount, parsePage } from '@/lib/pagination';
import { parseTaskFilter, type TaskFilter } from '@/lib/task-query';
import NotifyBanner from '@/components/NotifyBanner';
import Pagination from '@/components/Pagination';
import ReminderCard from '@/components/ReminderCard';
import TaskCard from '@/components/TaskCard';
import TaskFilters from '@/components/TaskFilters';

export const dynamic = 'force-dynamic';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const EMPTY_TASKS: Record<TaskFilter, string> = {
  pendientes: 'No tienes tareas pendientes 🎉',
  silenciadas: 'No has silenciado ninguna tarea.',
  entregadas: 'Aún no hay tareas entregadas.',
};

export default async function HomePage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const params = await searchParams;
  const filter = parseTaskFilter(params.tf);
  const now = new Date();
  const nowSeconds = Math.floor(now.getTime() / 1000);

  const [taskResult, reminderResult, counts] = await Promise.all([
    listTasksPage(user.id, filter, parsePage(params.tp), nowSeconds).catch(() => null),
    listRemindersPage(user.id, parsePage(params.rp)).catch(() => null),
    countTasks(user.id, nowSeconds),
  ]);

  const tasks: MoodleTask[] = taskResult?.tasks ?? [];
  const taskPage = taskResult?.page ?? 1;
  const taskPages = pageCount(taskResult?.total ?? 0);
  const reminders: Reminder[] = reminderResult?.reminders ?? [];
  const reminderPage = reminderResult?.page ?? 1;
  const reminderPages = pageCount(reminderResult?.total ?? 0);

  // Linked tasks may no longer be pending, so resolve them by id.
  const linkedIds = reminders.map((r) => r.task_id).filter((id): id is string => !!id);
  const linked = new Map<string, MoodleTask>(
    (await listTasksByIds(user.id, linkedIds).catch(() => [])).map((t) => [t.id, t]),
  );

  const listState = { tf: filter, tp: taskPage, rp: reminderPage };

  return (
    <>
      <NotifyBanner vapidPublicKey={process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY} />

      {user.last_error && (
        <p className="alert" role="alert">Moodle desconectado: vuelve a iniciar sesión para reconectar</p>
      )}

      <section aria-labelledby="tasks-title" id="tareas" className="section">
        <div className="section-head">
          <h1 id="tasks-title">Mis tareas</h1>
        </div>
        <TaskFilters active={filter} counts={counts} reminderPage={reminderPage} />
        {!taskResult && <p className="alert" role="alert">No se pudieron cargar las tareas de Moodle.</p>}
        {taskResult && tasks.length === 0 && <p className="card muted empty">{EMPTY_TASKS[filter]}</p>}
        <ul className="list">
          {tasks.map((t) => (
            <TaskCard key={t.id} task={t} nowSeconds={nowSeconds} listState={listState} />
          ))}
        </ul>
        <Pagination
          page={taskPage}
          pages={taskPages}
          label="Paginación de tareas"
          hrefFor={(p) => homeHref({ tf: filter, tp: p, rp: reminderPage }, 'tareas')}
        />
      </section>

      <section aria-labelledby="reminders-title" id="recordatorios" className="section">
        <div className="section-head">
          <h2 id="reminders-title">Recordatorios</h2>
          <Link href="/reminders/new" className="btn primary">Nuevo</Link>
        </div>
        {!reminderResult && <p className="alert" role="alert">No se pudieron cargar los recordatorios.</p>}
        {reminderResult && reminders.length === 0 && (
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
        <Pagination
          page={reminderPage}
          pages={reminderPages}
          label="Paginación de recordatorios"
          hrefFor={(p) => homeHref({ tf: filter, tp: taskPage, rp: p }, 'recordatorios')}
        />
      </section>
      <p className="muted small">Horas en Ecuador (UTC-5).</p>
    </>
  );
}
