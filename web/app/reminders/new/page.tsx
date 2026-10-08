import { requireUser } from '@/lib/auth';
import { resolvePreselect } from '@/lib/reminder-preselect';
import { dateToGuayaquilInput } from '@/lib/time';
import { MAX_TITLE } from '@/lib/validate';
import { getOwnedTask, listPendingTasks, type MoodleTask } from '@/lib/tasks';
import { saveReminder } from '@/app/actions';
import ReminderForm from '@/components/ReminderForm';

export const dynamic = 'force-dynamic';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function NewReminderPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const { task: taskParam } = await searchParams;
  const now = new Date();

  const tasks: MoodleTask[] = await listPendingTasks(user.id).catch(() => []);
  // `?task=<id>` only counts when the task belongs to the session user (checked server-side).
  const preselected = await resolvePreselect(taskParam, (id) => getOwnedTask(user.id, id));
  if (preselected && !tasks.some((t) => t.id === preselected.id)) tasks.push(preselected);

  // A future deadline is a sensible end for the reminder; past ones are left blank.
  const dueDate = preselected ? new Date(preselected.due_timestamp * 1000) : null;
  const endsAt = dueDate && dueDate.getTime() > now.getTime() ? dateToGuayaquilInput(dueDate) : '';

  return (
    <>
      <h1>Nuevo recordatorio</h1>
      <ReminderForm
        action={saveReminder.bind(null, null)}
        submitLabel="Crear"
        tasks={tasks}
        initial={{
          title: preselected ? preselected.title.slice(0, MAX_TITLE) : '',
          message: '',
          amount: '1',
          unit: 'hours',
          startsAt: dateToGuayaquilInput(now),
          endsAt,
          taskId: preselected?.id ?? '',
        }}
      />
    </>
  );
}
