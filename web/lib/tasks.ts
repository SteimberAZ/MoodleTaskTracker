import 'server-only';
import { dbJson, dbJsonCounted } from './db';
import { clampPage } from './pagination';
import { ownedTaskQuery, ownedTasksInQuery, scopedQuery } from './queries';
import {
  LEGACY_COLUMNS,
  LIST_COLUMNS,
  countTasksByFilter,
  muteTaskRequest,
  taskCountsQuery,
  taskDetailQuery,
  taskListQuery,
  type TaskCountRow,
  type TaskFilter,
} from './task-query';

/** Row of `moodle_tasks`, mirrored by the Python worker. `due_timestamp` is Unix seconds. */
export interface MoodleTask {
  id: string;
  title: string;
  course: string | null;
  due_date_str: string | null;
  due_timestamp: number;
  task_url: string | null;
  status: string;
  /** 1 when the user muted the task from the web (no notifications, hidden from "Pendientes"). */
  is_dismissed?: number | null;
  /** Moodle `modname` ("assign", "quiz", ...). Null on rows saved before the detail columns existed. */
  module?: string | null;
}

/** Detail columns are all optional: old rows have them null and the page degrades gracefully. */
export interface MoodleTaskDetail extends MoodleTask {
  course_id?: number | null;
  description?: string | null;
  teachers?: unknown;
  details_updated_at?: string | null;
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

export interface TaskPage {
  tasks: MoodleTask[];
  total: number;
  /** The page actually served (the requested one clamped into range). */
  page: number;
}

/** One page of a tab (8 per page) plus the exact total. An out-of-range page falls back to the last one. */
export async function listTasksPage(
  userId: string,
  filter: TaskFilter,
  page: number,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<TaskPage> {
  const read = (columns: string, p: number) =>
    dbJsonCounted<MoodleTask>(`moodle_tasks${taskListQuery(userId, filter, nowSeconds, p, columns)}`, FAILURE);

  // Falls back to the pre-migration columns (no `module`) when the database has not been migrated yet.
  let columns = LIST_COLUMNS;
  let first: Awaited<ReturnType<typeof read>>;
  try {
    first = await read(columns, page);
  } catch {
    columns = LEGACY_COLUMNS;
    first = await read(columns, page);
  }

  const served = clampPage(page, first.total);
  if (served === page) return { tasks: first.rows, total: first.total, page };
  const again = await read(columns, served);
  return { tasks: again.rows, total: again.total, page: served };
}

/** Chip counters. Never throws: the list still works without them. */
export async function countTasks(
  userId: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<Record<TaskFilter, number> | null> {
  try {
    const rows = await dbJson<TaskCountRow[]>(`moodle_tasks${taskCountsQuery(userId)}`, {}, FAILURE);
    return countTasksByFilter(rows, nowSeconds);
  } catch {
    return null;
  }
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

/** Full task for the detail page, only if it belongs to the user (null otherwise, including malformed ids). */
export async function getTaskDetail(userId: string, taskId: string): Promise<MoodleTaskDetail | null> {
  let query: string;
  let legacyQuery: string;
  try {
    query = taskDetailQuery(userId, taskId);
    legacyQuery = taskDetailQuery(userId, taskId, LEGACY_COLUMNS);
  } catch {
    return null;
  }
  // Falls back to the pre-migration columns when the detail columns do not exist yet.
  const rows = await dbJson<MoodleTaskDetail[]>(`moodle_tasks${query}`, {}, FAILURE).catch(() =>
    dbJson<MoodleTaskDetail[]>(`moodle_tasks${legacyQuery}`, {}, FAILURE),
  );
  return rows[0] ?? null;
}

/** Mutes (is_dismissed = 1) or restores a task. Matches id AND owner; returns false when nothing matched. */
export async function setTaskMuted(userId: string, taskId: string, muted: boolean): Promise<boolean> {
  let request: ReturnType<typeof muteTaskRequest>;
  try {
    request = muteTaskRequest(userId, taskId, muted);
  } catch {
    return false;
  }
  const rows = await dbJson<{ id: string }[]>(
    `moodle_tasks${request.query}`,
    { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(request.body) },
    'No se pudo actualizar la tarea.',
  );
  return rows.length > 0;
}
