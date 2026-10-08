import { pageRange } from './pagination';
import { scopedQuery } from './queries';

/**
 * Owner-scoped page query: active reminders first (soonest notice first), then paused and finished ones.
 * The displayed status is still derived per row; this only decides the server-side order.
 */
export function reminderPageQuery(userId: string, page: number): string {
  const { limit, offset } = pageRange(page);
  return scopedQuery(userId, 'select=*', 'order=active.desc,next_fire_at.asc', `limit=${limit}`, `offset=${offset}`);
}
