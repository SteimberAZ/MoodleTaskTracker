import 'server-only';
import { cache } from 'react';
import { dbFetch, dbJson } from './db';
import { clampPage, parseContentRange, TASK_PAGE_SIZE } from './pagination';
import { parseMilestoneRows, type SentMap } from './auto-reminders';
import { ownedTaskQuery, scopedQuery, userRowQuery } from './queries';
import {
  DETAIL_COLUMNS,
  LEGACY_COLUMNS,
  LIST_COLUMNS,
  MILESTONES_EMBED,
  TASK_FILTERS,
  isMissingSinceSupported,
  isUnknownColumnError,
  markMissingSinceUnsupported,
  muteTaskRequest,
  taskCountQuery,
  taskDetailQuery,
  taskListQuery,
  usesMissingSince,
  withEmbed,
  type TaskFilter,
} from './task-query';

/**
 * Row of `moodle_tasks`, mirrored by the Python worker. `due_timestamp` is Unix seconds, 0 (or null on old rows)
 * when the activity has no due date; use `hasDueDate` from './task-time' before reading it as a time.
 */
export interface MoodleTask {
  id: string;
  title: string;
  course: string | null;
  due_date_str: string | null;
  /** Unix seconds; 0 (or null on old rows) when the activity has no due date. */
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
  /** Automatic-alert milestones already recorded; null when they could not be read (schedule only). */
  milestones: SentMap | null;
}

const COLUMNS = 'select=id,title,course,due_date_str,due_timestamp,task_url,status';
const FAILURE = 'No se pudieron cargar las tareas.';

/**
 * A failed read with what PostgREST said about it. `status` 0 means the request never got an answer
 * (network error or timeout). The body is parsed for `code`/`message` only and never logged.
 */
export class DbReadError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly detail: string,
  ) {
    super(message);
    this.name = 'DbReadError';
  }

  get unknownColumn(): boolean {
    return isUnknownColumnError(this.status, this.code);
  }

  mentions(column: string): boolean {
    return this.detail.includes(column);
  }
}

async function errorFrom(res: Response, failure: string): Promise<DbReadError> {
  let code: string | null = null;
  let detail = '';
  try {
    const body = (await res.json()) as { code?: unknown; message?: unknown };
    if (typeof body.code === 'string') code = body.code;
    if (typeof body.message === 'string') detail = body.message;
  } catch {
    // Not JSON: status alone decides.
  }
  // Status and code only: error bodies can echo row data.
  console.error('Supabase request failed', res.status, code ?? '');
  return new DbReadError(failure, res.status, code, detail);
}

/**
 * GET through `dbFetch` (session re-check, platform timeout) that keeps the PostgREST error code, so callers
 * can tell "this column does not exist yet" from an outage. With `counted` it also reads the exact total.
 */
export async function dbRead<T>(
  path: string,
  failure: string,
  counted = false,
): Promise<{ rows: T[]; total: number }> {
  let res: Response;
  try {
    res = await dbFetch(path, counted ? { headers: { Prefer: 'count=exact' } } : {});
  } catch (error) {
    // `redirect()` from the session check must keep propagating.
    if (error instanceof Error && 'digest' in error) throw error;
    console.error('Supabase request failed', error instanceof Error ? error.name : 'unknown');
    throw new DbReadError(failure, 0, null, '');
  }
  const total = counted ? parseContentRange(res.headers.get('content-range')) : null;
  if (counted && res.status === 416) return { rows: [], total: total ?? 0 };
  if (!res.ok) throw await errorFrom(res, failure);
  const text = await res.text();
  const rows = (text ? JSON.parse(text) : []) as T[];
  return { rows, total: total ?? rows.length };
}

interface ColumnPlan {
  legacy: boolean;
  missingSince: boolean;
}

/**
 * Runs a read and, only when PostgREST rejects a column, retries without it: first `missing_since` (and the
 * module flag remembers that), then the pre-migration column set. Every other failure is thrown as is.
 */
async function readWithColumnFallback<T>(
  build: (plan: ColumnPlan) => string,
  failure: string,
  counted: boolean,
  usesMissingSince: boolean,
): Promise<{ rows: T[]; total: number }> {
  let plan: ColumnPlan = { legacy: false, missingSince: usesMissingSince && isMissingSinceSupported() };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await dbRead<T>(build(plan), failure, counted);
    } catch (error) {
      if (!(error instanceof DbReadError) || !error.unknownColumn) throw error;
      if (plan.missingSince && (error.mentions('missing_since') || plan.legacy)) {
        markMissingSinceUnsupported();
        plan = { ...plan, missingSince: false };
      } else if (!plan.legacy) {
        plan = { ...plan, legacy: true };
      } else {
        throw error;
      }
    }
  }
  throw new DbReadError(failure, 400, null, '');
}

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

/** One page of a tab (15 per page) plus the exact total. An out-of-range page falls back to the last one. */
export async function listTasksPage(
  userId: string,
  filter: TaskFilter,
  page: number,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<TaskPage> {
  const read = (p: number) =>
    readWithColumnFallback<MoodleTask>(
      (plan) =>
        `moodle_tasks${taskListQuery(userId, filter, nowSeconds, p, plan.legacy ? LEGACY_COLUMNS : LIST_COLUMNS, {
          missingSince: plan.missingSince,
        })}`,
      FAILURE,
      true,
      true,
    );

  const first = await read(page);
  const served = clampPage(page, first.total, TASK_PAGE_SIZE);
  if (served === page) return { tasks: first.rows, total: first.total, page };
  const again = await read(served);
  return { tasks: again.rows, total: again.total, page: served };
}

export interface TaskCounts {
  byFilter: Record<TaskFilter, number>;
  /** Every task row of the user, in any state (0 means the first sync has not brought anything yet). */
  total: number;
}

/**
 * Chip counters: one exact count per tab plus the total, read in parallel (no rows are downloaded, so the
 * counts stay right for users with more rows than PostgREST's max-rows). Never throws: the list still works
 * without them.
 */
export async function countTasks(
  userId: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<TaskCounts | null> {
  const count = async (filter: TaskFilter | null) =>
    (
      await readWithColumnFallback<{ id: string }>(
        (plan) => `moodle_tasks${taskCountQuery(userId, filter, nowSeconds, { missingSince: plan.missingSince })}`,
        FAILURE,
        true,
        usesMissingSince(filter),
      )
    ).total;
  try {
    const filters = TASK_FILTERS.map(({ value }) => value);
    const [total, ...perFilter] = await Promise.all([count(null), ...filters.map((filter) => count(filter))]);
    const byFilter = Object.fromEntries(filters.map((filter, i) => [filter, perFilter[i]])) as Record<TaskFilter, number>;
    return { byFilter, total };
  } catch {
    return null;
  }
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

type DetailRow = Omit<MoodleTaskDetail, 'milestones'> & { moodle_task_milestones?: unknown };

/**
 * Full task for the detail page with its recorded milestones embedded, only if it belongs to the user (null
 * otherwise, including malformed ids). Cached per request so `generateMetadata` and the page share one read.
 * When the embed is rejected the plain row is read instead and `milestones` is null.
 */
export const getTaskDetail = cache(async (userId: string, taskId: string): Promise<MoodleTaskDetail | null> => {
  try {
    taskDetailQuery(userId, taskId);
  } catch {
    return null;
  }

  const plain = async (): Promise<MoodleTaskDetail | null> => {
    const { rows } = await readWithColumnFallback<DetailRow>(
      (plan) => `moodle_tasks${taskDetailQuery(userId, taskId, plan.legacy ? LEGACY_COLUMNS : DETAIL_COLUMNS)}`,
      FAILURE,
      false,
      false,
    );
    return rows[0] ? { ...rows[0], milestones: null } : null;
  };

  let rows: DetailRow[];
  try {
    ({ rows } = await dbRead<DetailRow>(
      `moodle_tasks${taskDetailQuery(userId, taskId, withEmbed(DETAIL_COLUMNS, MILESTONES_EMBED))}`,
      FAILURE,
    ));
  } catch (error) {
    // An answered 4xx means the embed (or a column) was rejected; outages are not retried.
    if (error instanceof DbReadError && error.status >= 400 && error.status < 500) return plain();
    throw error;
  }
  const row = rows[0];
  if (!row) return null;
  const { moodle_task_milestones: embedded, ...task } = row;
  return { ...task, milestones: Array.isArray(embedded) ? parseMilestoneRows(embedded) : null };
});

export interface TaskSyncState {
  createdAt: string | null;
  lastLoginAt: string | null;
  /** Undefined when the column does not exist yet (worker or SQL not deployed). */
  lastSyncedAt?: string | null;
}

/** Sync markers of the session user for the first-sync notice. Never throws (null = unknown). */
export async function getTaskSyncState(userId: string): Promise<TaskSyncState | null> {
  type Row = { created_at?: string | null; last_login_at?: string | null; last_synced_at?: string | null };
  try {
    const { rows } = await readWithColumnFallback<Row>(
      (plan) =>
        `moodle_users${userRowQuery(
          userId,
          plan.legacy ? 'select=created_at,last_login_at' : 'select=created_at,last_login_at,last_synced_at',
          'limit=1',
        )}`,
      'No se pudo leer el estado de sincronización.',
      false,
      false,
    );
    const row = rows[0];
    if (!row) return null;
    return {
      createdAt: row.created_at ?? null,
      lastLoginAt: row.last_login_at ?? null,
      ...('last_synced_at' in row ? { lastSyncedAt: row.last_synced_at ?? null } : {}),
    };
  } catch {
    return null;
  }
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
