import { pageRange } from './pagination';
import { ownedRowQuery, scopedQuery } from './queries';

/**
 * Linked task embedded through `task_id` (a to-one join, so `count=exact` still counts reminder rows). It is
 * a LEFT join (no `!inner`): reminders without a task, or whose task is gone, are still listed.
 */
export const REMINDER_TASK_EMBED = 'task:moodle_tasks(id,title,course,due_date_str,due_timestamp,task_url,status,user_id)';

/**
 * Owner-scoped page query: active reminders first (soonest notice first), then paused and finished ones.
 * The displayed status is still derived per row; this only decides the server-side order.
 */
export function reminderPageQuery(userId: string, page: number, withTask = false): string {
  const { limit, offset } = pageRange(page);
  return scopedQuery(
    userId,
    withTask ? `select=*,${REMINDER_TASK_EMBED}` : 'select=*',
    'order=active.desc,next_fire_at.asc',
    `limit=${limit}`,
    `offset=${offset}`,
  );
}

/** One reminder of the owner, optionally with its linked task embedded. */
export function reminderRowQuery(userId: string, id: string, withTask = false): string {
  return ownedRowQuery(userId, id, withTask ? `select=*,${REMINDER_TASK_EMBED}` : 'select=*', 'limit=1');
}

/**
 * `PATCH` filter for an idempotent pause/resume: it only matches while the row still has the `active` value
 * the action read, so a repeated or concurrent request changes nothing.
 */
export function reminderActiveFilter(userId: string, id: string, currentActive: boolean): string {
  return ownedRowQuery(userId, id, `active=eq.${currentActive}`);
}

export interface EmbeddedTask {
  id: string;
  title: string;
  course: string | null;
  due_date_str: string | null;
  due_timestamp: number;
  task_url: string | null;
  status: string;
  user_id?: string | null;
}

/** An embedded task only counts when it exists and belongs to the reminder's owner. */
export function ownedEmbeddedTask(task: unknown, userId: string): EmbeddedTask | null {
  if (!task || typeof task !== 'object' || Array.isArray(task)) return null;
  const t = task as EmbeddedTask;
  if (typeof t.id !== 'string' || t.user_id !== userId) return null;
  return t;
}
