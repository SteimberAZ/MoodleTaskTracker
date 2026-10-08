import { notFound } from 'next/navigation';
import { requireSession } from '@/lib/auth';
import { getReminder } from '@/lib/reminders';
import { splitInterval } from '@/lib/schedule';
import { dateToGuayaquilInput } from '@/lib/time';
import { saveReminder } from '@/app/actions';
import ReminderForm from '@/components/ReminderForm';

export const dynamic = 'force-dynamic';

export default async function EditReminderPage({ params }: { params: Promise<{ id: string }> }) {
  await requireSession();
  const { id } = await params;
  const reminder = await getReminder(id);
  if (!reminder) notFound();
  const { amount, unit } = splitInterval(reminder.interval_minutes);

  return (
    <>
      <h1>Editar recordatorio</h1>
      <ReminderForm
        action={saveReminder.bind(null, reminder.id)}
        submitLabel="Guardar"
        initial={{
          title: reminder.title,
          message: reminder.message ?? '',
          amount: String(amount),
          unit,
          startsAt: dateToGuayaquilInput(new Date(reminder.starts_at)),
          endsAt: dateToGuayaquilInput(new Date(reminder.ends_at)),
        }}
      />
    </>
  );
}
