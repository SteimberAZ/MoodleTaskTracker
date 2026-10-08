import { pageRange, TASK_PAGE_SIZE } from './pagination';
import { ownedTaskQuery, scopedQuery } from './queries';

/** Pure builders for the task list. Every query goes through `scopedQuery`, so `user_id` is always present. */
export type TaskFilter = 'pendientes' | 'atrasadas' | 'silenciadas' | 'entregadas';

export const TASK_FILTERS: readonly { value: TaskFilter; label: string }[] = [
  { value: 'pendientes', label: 'Pendientes' },
  { value: 'atrasadas', label: 'Atrasadas' },
  { value: 'silenciadas', label: 'Silenciadas' },
  { value: 'entregadas', label: 'Entregadas' },
];

export const DEFAULT_TASK_FILTER: TaskFilter = 'pendientes';

/**
 * How far back the 'Atrasadas' tab looks. Must match `OVERDUE_WINDOW_DAYS` in moodle_api.py, which is how
 * long the worker keeps fetching (and therefore refreshing) a task after its deadline.
 */
export const OVERDUE_WINDOW_DAYS = 7;
const OVERDUE_WINDOW_SECONDS = OVERDUE_WINDOW_DAYS * 24 * 60 * 60;

export function parseTaskFilter(raw: string | string[] | undefined | null): TaskFilter {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return TASK_FILTERS.some((f) => f.value === value) ? (value as TaskFilter) : DEFAULT_TASK_FILTER;
}

/** Columns the list and the detail page read (the detail also needs description and teachers). */
export const LIST_COLUMNS = 'select=id,title,course,due_date_str,due_timestamp,task_url,status,is_dismissed,module';
export const DETAIL_COLUMNS =
  'select=id,title,course,due_date_str,due_timestamp,task_url,status,is_dismissed,module,course_id,description,teachers,details_updated_at';
/**
 * Columns that existed before the detail migration. Only used after PostgREST explicitly rejected a column
 * (see `isUnknownColumnError`), so a deploy that lands before the SQL still shows the list and the detail page.
 */
export const LEGACY_COLUMNS = 'select=id,title,course,due_date_str,due_timestamp,task_url,status,is_dismissed';

/** Milestones the worker recorded, embedded through the `task_id` foreign key (no extra round trip). */
export const MILESTONES_EMBED = 'moodle_task_milestones(milestone,sent_at)';

/** `select=...` plus an embedded resource. */
export function withEmbed(columns: string, embed: string): string {
  return `${columns},${embed}`;
}

/**
 * `moodle_tasks.missing_since` (set by the worker when Moodle stopped returning a task) is newer than the web
 * deploy may be. When PostgREST rejects the column it is dropped from the queries for the rest of the
 * instance lifetime, the same idea as the worker's per-column `*_supported` flags.
 */
let missingSinceSupported = true;

export function isMissingSinceSupported(): boolean {
  return missingSinceSupported;
}

export function markMissingSinceUnsupported(): void {
  missingSinceSupported = false;
}

/** Test hook: restores the optimistic default. */
export function resetMissingSinceSupport(): void {
  missingSinceSupported = true;
}

/**
 * True for the PostgREST answers that mean "this column does not exist": 400 with `PGRST204` (schema cache)
 * or `42703` (undefined column). Anything else (timeouts, 5xx, auth) must not trigger a column fallback.
 */
export function isUnknownColumnError(status: number, code: string | null | undefined): boolean {
  return status === 400 && (code === 'PGRST204' || code === '42703');
}

export interface TaskQueryOptions {
  /** Adds `missing_since=is.null` to the tabs that list actionable tasks. Defaults to the module flag. */
  missingSince?: boolean;
}

const notMissing = (options: TaskQueryOptions): string[] =>
  (options.missingSince ?? missingSinceSupported) ? ['missing_since=is.null'] : [];

/** PostgREST filters and ordering of one tab. */
export function taskFilterParts(filter: TaskFilter, nowSeconds: number, options: TaskQueryOptions = {}): string[] {
  const now = Math.floor(nowSeconds);
  switch (filter) {
    case 'silenciadas':
      return ['is_dismissed=eq.1', 'order=due_timestamp.asc'];
    case 'entregadas':
      return ['status=eq.submitted', 'order=due_timestamp.desc'];
    case 'atrasadas':
      return [
        'status=neq.submitted',
        'is_dismissed=eq.0',
        `due_timestamp=lt.${now}`,
        `due_timestamp=gte.${now - OVERDUE_WINDOW_SECONDS}`,
        ...notMissing(options),
        'order=due_timestamp.desc',
      ];
    default:
      return [
        'status=neq.submitted',
        'is_dismissed=eq.0',
        `due_timestamp=gte.${now}`,
        ...notMissing(options),
        'order=due_timestamp.asc',
      ];
  }
}

/** One page of one tab for one user. */
export function taskListQuery(
  userId: string,
  filter: TaskFilter,
  nowSeconds: number,
  page: number,
  columns: string = LIST_COLUMNS,
  options: TaskQueryOptions = {},
): string {
  const { limit, offset } = pageRange(page, TASK_PAGE_SIZE);
  return scopedQuery(
    userId,
    columns,
    ...taskFilterParts(filter, nowSeconds, options),
    `limit=${limit}`,
    `offset=${offset}`,
  );
}

/** Minimal rows used to compute the chip counters in one cheap request. */
export const COUNT_COLUMNS = 'select=status,is_dismissed,due_timestamp';

export function taskCountsQuery(userId: string, options: TaskQueryOptions = {}): string {
  const missingSince = options.missingSince ?? missingSinceSupported;
  return scopedQuery(userId, missingSince ? `${COUNT_COLUMNS},missing_since` : COUNT_COLUMNS);
}

export interface TaskCountRow {
  status: string;
  is_dismissed: number | null;
  due_timestamp: number;
  /** Absent when the column does not exist yet: the task then counts as present. */
  missing_since?: string | null;
}

/** Mirrors `taskFilterParts` in memory; keep the two in sync (covered by tests). */
export function matchesTaskFilter(row: TaskCountRow, filter: TaskFilter, nowSeconds: number): boolean {
  const now = Math.floor(nowSeconds);
  const actionable = row.status !== 'submitted' && !row.is_dismissed && !row.missing_since;
  switch (filter) {
    case 'silenciadas':
      return row.is_dismissed === 1;
    case 'entregadas':
      return row.status === 'submitted';
    case 'atrasadas':
      return actionable && row.due_timestamp < now && row.due_timestamp >= now - OVERDUE_WINDOW_SECONDS;
    default:
      return actionable && row.due_timestamp >= now;
  }
}

export function countTasksByFilter(rows: TaskCountRow[], nowSeconds: number): Record<TaskFilter, number> {
  const counts: Record<TaskFilter, number> = { pendientes: 0, atrasadas: 0, silenciadas: 0, entregadas: 0 };
  for (const row of rows) {
    for (const { value } of TASK_FILTERS) {
      if (matchesTaskFilter(row, value, nowSeconds)) counts[value] += 1;
    }
  }
  return counts;
}

/** `PATCH moodle_tasks?user_id=eq.<me>&id=eq.<task>` with `{is_dismissed: 0|1}`: owner and id are always both matched. */
export function muteTaskRequest(userId: string, taskId: string, muted: boolean): { query: string; body: { is_dismissed: 0 | 1 } } {
  return { query: ownedTaskQuery(userId, taskId, 'select=id'), body: { is_dismissed: muted ? 1 : 0 } };
}

/**
 * Single task for the detail page, owner-scoped. The milestones embed is safe: PostgREST only joins the
 * milestone rows of the task the owner filter already matched.
 */
export function taskDetailQuery(userId: string, taskId: string, columns: string = DETAIL_COLUMNS): string {
  return ownedTaskQuery(userId, taskId, columns, 'limit=1');
}
