import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { withUser } from '@/lib/auth';
import { getReminderWithTask } from '@/lib/reminders';
import { splitInterval } from '@/lib/schedule';
import { dateToGuayaquilInput } from '@/lib/time';
import { listPendingTasks, type MoodleTask } from '@/lib/tasks';
import { saveReminder } from '@/app/actions';
import { ChevronLeftIcon } from '@/components/Icons';
import ReminderForm from '@/components/ReminderForm';
import { REMINDERS_PATH } from '@/lib/nav';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Editar recordatorio' };

export default async function EditReminderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Both reads start together; the linked task comes embedded in the reminder row.
  const [, [reminder, tasks]] = await withUser((userId) =>
    Promise.all([getReminderWithTask(userId, id), listPendingTasks(userId).catch((): MoodleTask[] => [])]),
  );
  if (!reminder) notFound();
  const { amount, unit } = splitInterval(reminder.interval_minutes);

  // Keep the linked task selectable even when it is no longer pending.
  if (reminder.task && !tasks.some((t) => t.id === reminder.task!.id)) tasks.push(reminder.task);

  return (
    <>
      <Link href={REMINDERS_PATH} className="back-link">
        <ChevronLeftIcon />
        <span>Volver a recordatorios</span>
      </Link>
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
