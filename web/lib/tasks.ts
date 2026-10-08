import 'server-only';
import { requireEnv, requireSession } from './auth';

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

/** Active tasks: not submitted, not dismissed, deadline still in the future. Soonest first. */
export async function listPendingTasks(nowSeconds = Math.floor(Date.now() / 1000)): Promise<MoodleTask[]> {
  await requireSession();
  const base = requireEnv('SUPABASE_URL').replace(/\/+$/, '');
  const key = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const query =
    '?select=id,title,course,due_date_str,due_timestamp,task_url,status' +
    '&status=neq.submitted&is_dismissed=eq.0' +
    `&due_timestamp=gte.${nowSeconds}&order=due_timestamp.asc`;
  const res = await fetch(`${base}/rest/v1/moodle_tasks${query}`, {
    cache: 'no-store',
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!res.ok) {
    console.error('Supabase tasks request failed', res.status, (await res.text()).slice(0, 300));
    throw new Error('No se pudieron cargar las tareas.');
  }
  return (await res.json()) as MoodleTask[];
}
