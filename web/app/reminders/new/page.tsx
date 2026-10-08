import { requireUser } from '@/lib/auth';
import { dateToGuayaquilInput } from '@/lib/time';
import { listPendingTasks } from '@/lib/tasks';
import { saveReminder } from '@/app/actions';
import ReminderForm from '@/components/ReminderForm';

export const dynamic = 'force-dynamic';

export default async function NewReminderPage() {
  const user = await requireUser();
  const tasks = await listPendingTasks(user.id).catch(() => []);
  return (
    <>
      <h1>Nuevo recordatorio</h1>
      <ReminderForm
        action={saveReminder.bind(null, null)}
        submitLabel="Crear"
        tasks={tasks}
        initial={{
          title: '',
          message: '',
          amount: '1',
          unit: 'hours',
          startsAt: dateToGuayaquilInput(new Date()),
          endsAt: '',
          taskId: '',
        }}
      />
    </>
  );
}
