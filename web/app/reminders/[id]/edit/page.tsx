import { notFound } from 'next/navigation';
import { requireSession } from '@/lib/auth';
import { getReminder } from '@/lib/reminders';
import { splitInterval } from '@/lib/schedule';
import { dateToGuayaquilInput } from '@/lib/time';
import { listPendingTasks, listTasksByIds, type MoodleTask } from '@/lib/tasks';
import { saveReminder } from '@/app/actions';
import ReminderForm from '@/components/ReminderForm';

export const dynamic = 'force-dynamic';

export default async function EditReminderPage({ params }: { params: Promise<{ id: string }> }) {
  await requireSession();
  const { id } = await params;
  const reminder = await getReminder(id);
  if (!reminder) notFound();
  const { amount, unit } = splitInterval(reminder.interval_minutes);

  const tasks: MoodleTask[] = await listPendingTasks().catch(() => []);
  // Keep the linked task selectable even when it is no longer pending.
  if (reminder.task_id && !tasks.some((t) => t.id === reminder.task_id)) {
    tasks.push(...(await listTasksByIds([reminder.task_id]).catch(() => [])));
  }

  return (
    <>
      <h1>Editar recordatorio</h1>
      <ReminderForm
        action={saveReminder.bind(null, reminder.id)}
        submitLabel="Guardar"
        tasks={tasks}
        initial={{
          title: reminder.title,
          message: reminder.message ?? '',
          amount: String(amount),
          unit,
          startsAt: dateToGuayaquilInput(new Date(reminder.starts_at)),
          endsAt: dateToGuayaquilInput(new Date(reminder.ends_at)),
          taskId: reminder.task_id ?? '',
        }}
      />
    </>
  );
}
