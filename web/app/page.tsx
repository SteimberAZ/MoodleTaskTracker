import type { Metadata } from 'next';
import { withUser } from '@/lib/auth';
import { countTasks, getTaskSyncState, listTasksPage, type MoodleTask } from '@/lib/tasks';
import { homeHref, pageCount, parsePage, TASK_PAGE_SIZE } from '@/lib/pagination';
import { parseTaskFilter, type TaskFilter } from '@/lib/task-query';
import { groupTasksByDay, isAwaitingFirstSync } from '@/lib/task-groups';
import { reconnectMoodle } from '@/app/actions';
import FirstSyncRefresher from '@/components/FirstSyncRefresher';
import NotifyBanner from '@/components/NotifyBanner';
import Pagination from '@/components/Pagination';
import SubmitButton from '@/components/SubmitButton';
import TaskCard from '@/components/TaskCard';
import TaskFilters from '@/components/TaskFilters';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Tareas' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const EMPTY_TASKS: Record<TaskFilter, string> = {
  pendientes: 'No tienes tareas pendientes 🎉',
  atrasadas: 'No tienes tareas atrasadas de los últimos 7 días.',
  sinfecha: 'No tienes tareas sin fecha de entrega.',
  silenciadas: 'No has silenciado ninguna tarea.',
  entregadas: 'Aún no hay tareas entregadas.',
};

const SYNCING = 'Estamos trayendo tus tareas de Moodle… (tarda hasta un minuto)';

export default async function HomePage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const filter = parseTaskFilter(params.tf);
  const now = new Date();
  const nowSeconds = Math.floor(now.getTime() / 1000);

  const [user, [taskResult, counts, sync]] = await withUser((userId) =>
    Promise.all([
      listTasksPage(userId, filter, parsePage(params.tp), nowSeconds).catch(() => null),
      countTasks(userId, nowSeconds),
      getTaskSyncState(userId),
    ]),
  );

  const tasks: MoodleTask[] = taskResult?.tasks ?? [];
  const taskPage = taskResult?.page ?? 1;
  const taskPages = pageCount(taskResult?.total ?? 0, TASK_PAGE_SIZE);
  const listState = { tf: filter, tp: taskPage };
  const syncing =
    filter === 'pendientes' &&
    !!taskResult &&
    tasks.length === 0 &&
    !!sync &&
    isAwaitingFirstSync({ ...sync, totalTasks: counts?.total ?? null }, now.getTime());
  const groups = filter === 'pendientes' ? groupTasksByDay(tasks, nowSeconds) : null;

  return (
    <>
      <NotifyBanner vapidPublicKey={process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY} />

      {user.last_error && (
        <div className="alert" role="alert">
          <p>Moodle desconectado: vuelve a iniciar sesión para reconectar</p>
          <form action={reconnectMoodle} className="inline-form">
            <SubmitButton className="btn" pendingLabel="Abriendo inicio de sesión…">
              Reconectar Moodle
            </SubmitButton>
          </form>
        </div>
      )}

      <section
        aria-labelledby="tasks-title"
        id="tareas"
        className="section"
        data-status-id="task-status"
        data-fallback-id="tasks-title"
      >
        <div className="section-head">
          <h1 id="tasks-title" tabIndex={-1}>Tareas</h1>
        </div>
        <TaskFilters active={filter} counts={counts?.byFilter ?? null} />
        {filter === 'sinfecha' && (
          <p className="muted small">Actividades de Moodle sin fecha límite: solo reciben el aviso de tarea nueva.</p>
        )}
        {/* Always mounted: mute results are announced here (text set by MuteButton). */}
        <p id="task-status" role="status" className="sr-only" />
        {!taskResult && <p className="alert" role="alert">No se pudieron cargar las tareas de Moodle.</p>}
        {syncing && (
          <>
            <p className="card muted empty" role="status">{SYNCING}</p>
            <FirstSyncRefresher />
          </>
        )}
        {taskResult && tasks.length === 0 && !syncing && <p className="card muted empty">{EMPTY_TASKS[filter]}</p>}
        {groups ? (
          groups.map((group) => (
            <div key={group.key} className="task-group">
              <h2 id={`grupo-${group.key}`} className="task-group-heading">{group.label}</h2>
              <ul className="list" aria-labelledby={`grupo-${group.key}`}>
                {group.items.map((t) => (
                  <TaskCard key={t.id} task={t} nowSeconds={nowSeconds} listState={listState} headingLevel={3} />
                ))}
              </ul>
            </div>
          ))
        ) : (
          <ul className="list">
            {tasks.map((t) => (
              <TaskCard
                key={t.id}
                task={t}
                nowSeconds={nowSeconds}
                listState={listState}
                overdue={filter === 'atrasadas'}
              />
            ))}
          </ul>
        )}
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
