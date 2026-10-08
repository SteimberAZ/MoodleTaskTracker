import 'server-only';
import { dbJson } from './db';

/** Row of `moodle_tasks`, mirrored by the Python worker. `due_timestamp` is Unix seconds. */
export interface MoodleTask {
  id: string;
  title: string;
  course: string | null;
  due_date_str: string | null;
  due_timestamp: number;
  task_url: string | null;
  status: string;
}

const COLUMNS = 'id,title,course,due_date_str,due_timestamp,task_url,status';

/** Active tasks: not submitted, not dismissed, deadline still in the future. Soonest first. */
export function listPendingTasks(nowSeconds = Math.floor(Date.now() / 1000)): Promise<MoodleTask[]> {
  return dbJson<MoodleTask[]>(
    `moodle_tasks?select=${COLUMNS}&status=neq.submitted&is_dismissed=eq.0` +
      `&due_timestamp=gte.${nowSeconds}&order=due_timestamp.asc`,
    {},
    'No se pudieron cargar las tareas.',
  );
}

/** Tasks by id regardless of state (a linked reminder's task may already be past due). */
export async function listTasksByIds(ids: string[]): Promise<MoodleTask[]> {
  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length === 0) return [];
  const list = unique.map((id) => `"${id.replace(/["\\]/g, '')}"`).join(',');
  return dbJson<MoodleTask[]>(
    `moodle_tasks?select=${COLUMNS}&id=in.(${encodeURIComponent(list)})`,
    {},
    'No se pudieron cargar las tareas.',
  );
}
