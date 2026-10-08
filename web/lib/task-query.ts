import { pageRange, PAGE_SIZE } from './pagination';
import { ownedTaskQuery, scopedQuery } from './queries';

/** Pure builders for the task list. Every query goes through `scopedQuery`, so `user_id` is always present. */
export type TaskFilter = 'pendientes' | 'silenciadas' | 'entregadas';

export const TASK_FILTERS: readonly { value: TaskFilter; label: string }[] = [
  { value: 'pendientes', label: 'Pendientes' },
  { value: 'silenciadas', label: 'Silenciadas' },
  { value: 'entregadas', label: 'Entregadas' },
];

export const DEFAULT_TASK_FILTER: TaskFilter = 'pendientes';

export function parseTaskFilter(raw: string | string[] | undefined | null): TaskFilter {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return TASK_FILTERS.some((f) => f.value === value) ? (value as TaskFilter) : DEFAULT_TASK_FILTER;
}

/** Columns the list and the detail page read (the detail also needs description and teachers). */
export const LIST_COLUMNS = 'select=id,title,course,due_date_str,due_timestamp,task_url,status,is_dismissed,module';
export const DETAIL_COLUMNS =
  'select=id,title,course,due_date_str,due_timestamp,task_url,status,is_dismissed,module,course_id,description,teachers,details_updated_at';
/**
 * Columns that existed before the detail migration. Used as a fallback while the database has not been
 * migrated yet, so a deploy that lands before the SQL still shows the list and the detail page.
 */
export const LEGACY_COLUMNS = 'select=id,title,course,due_date_str,due_timestamp,task_url,status,is_dismissed';

/** PostgREST filters and ordering of one tab. */
export function taskFilterParts(filter: TaskFilter, nowSeconds: number): string[] {
  switch (filter) {
    case 'silenciadas':
      return ['is_dismissed=eq.1', 'order=due_timestamp.asc'];
    case 'entregadas':
      return ['status=eq.submitted', 'order=due_timestamp.desc'];
    default:
      return [
        'status=neq.submitted',
        'is_dismissed=eq.0',
        `due_timestamp=gte.${Math.floor(nowSeconds)}`,
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
): string {
  const { limit, offset } = pageRange(page, PAGE_SIZE);
  return scopedQuery(userId, columns, ...taskFilterParts(filter, nowSeconds), `limit=${limit}`, `offset=${offset}`);
}

/** Minimal rows used to compute the chip counters in one cheap request. */
export const COUNT_COLUMNS = 'select=status,is_dismissed,due_timestamp';

export function taskCountsQuery(userId: string): string {
  return scopedQuery(userId, COUNT_COLUMNS);
}

export interface TaskCountRow {
  status: string;
  is_dismissed: number | null;
  due_timestamp: number;
}

/** Mirrors `taskFilterParts` in memory; keep the two in sync (covered by tests). */
export function matchesTaskFilter(row: TaskCountRow, filter: TaskFilter, nowSeconds: number): boolean {
  switch (filter) {
    case 'silenciadas':
      return row.is_dismissed === 1;
    case 'entregadas':
      return row.status === 'submitted';
    default:
      return row.status !== 'submitted' && !row.is_dismissed && row.due_timestamp >= Math.floor(nowSeconds);
  }
}

export function countTasksByFilter(rows: TaskCountRow[], nowSeconds: number): Record<TaskFilter, number> {
  const counts: Record<TaskFilter, number> = { pendientes: 0, silenciadas: 0, entregadas: 0 };
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

/** Single task for the detail page, owner-scoped. */
export function taskDetailQuery(userId: string, taskId: string, columns: string = DETAIL_COLUMNS): string {
  return ownedTaskQuery(userId, taskId, columns, 'limit=1');
}
