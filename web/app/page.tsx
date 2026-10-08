import { requireUser } from '@/lib/auth';
import { countTasks, listTasksPage, type MoodleTask } from '@/lib/tasks';
import { homeHref, pageCount, parsePage } from '@/lib/pagination';
import { parseTaskFilter, type TaskFilter } from '@/lib/task-query';
import NotifyBanner from '@/components/NotifyBanner';
import Pagination from '@/components/Pagination';
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

  const [taskResult, counts] = await Promise.all([
    listTasksPage(user.id, filter, parsePage(params.tp), nowSeconds).catch(() => null),
    countTasks(user.id, nowSeconds),
  ]);

  const tasks: MoodleTask[] = taskResult?.tasks ?? [];
  const taskPage = taskResult?.page ?? 1;
  const taskPages = pageCount(taskResult?.total ?? 0);
  const listState = { tf: filter, tp: taskPage };

  return (
    <>
      <NotifyBanner vapidPublicKey={process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY} />

      {user.last_error && (
        <p className="alert" role="alert">Moodle desconectado: vuelve a iniciar sesión para reconectar</p>
      )}

      <section aria-labelledby="tasks-title" id="tareas" className="section">
        <div className="section-head">
          <h1 id="tasks-title">Tareas</h1>
        </div>
        <TaskFilters active={filter} counts={counts} />
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
          hrefFor={(p) => homeHref({ tf: filter, tp: p }, 'tareas')}
        />
      </section>

      <p className="muted small">Horas en Ecuador (UTC-5).</p>
    </>
  );
}
