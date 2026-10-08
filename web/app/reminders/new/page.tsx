import { requireSession } from '@/lib/auth';
import { dateToGuayaquilInput } from '@/lib/time';
import { saveReminder } from '@/app/actions';
import ReminderForm from '@/components/ReminderForm';

export const dynamic = 'force-dynamic';

export default async function NewReminderPage() {
  await requireSession();
  return (
    <>
      <h1>Nuevo recordatorio</h1>
      <ReminderForm
        action={saveReminder.bind(null, null)}
        submitLabel="Crear"
        initial={{
          title: '',
          message: '',
          amount: '1',
          unit: 'hours',
          startsAt: dateToGuayaquilInput(new Date()),
          endsAt: '',
        }}
      />
    </>
  );
}
