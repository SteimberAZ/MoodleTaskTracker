import 'server-only';
import { dbJson } from './db';
import { ownedTaskQuery, ownedTasksInQuery, scopedQuery } from './queries';

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

const COLUMNS = 'select=id,title,course,due_date_str,due_timestamp,task_url,status';
const FAILURE = 'No se pudieron cargar las tareas.';

/** Active tasks of one user: not submitted, not dismissed, deadline in the future. Soonest first. */
export function listPendingTasks(userId: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<MoodleTask[]> {
  return dbJson<MoodleTask[]>(
    `moodle_tasks${scopedQuery(
      userId,
      COLUMNS,
      'status=neq.submitted',
      'is_dismissed=eq.0',
      `due_timestamp=gte.${Math.floor(nowSeconds)}`,
      'order=due_timestamp.asc',
    )}`,
    {},
    FAILURE,
  );
}

/** The user's tasks by id regardless of state (a linked reminder's task may already be past due). */
export async function listTasksByIds(userId: string, ids: string[]): Promise<MoodleTask[]> {
  if (ids.length === 0) return [];
  return dbJson<MoodleTask[]>(`moodle_tasks${ownedTasksInQuery(userId, ids, COLUMNS)}`, {}, FAILURE);
}

/** A single task, only if it belongs to the user. */
export async function getOwnedTask(userId: string, taskId: string): Promise<MoodleTask | null> {
  let query: string;
  try {
    query = ownedTaskQuery(userId, taskId, COLUMNS, 'limit=1');
  } catch {
    return null;
  }
  const rows = await dbJson<MoodleTask[]>(`moodle_tasks${query}`, {}, FAILURE);
  return rows[0] ?? null;
}
