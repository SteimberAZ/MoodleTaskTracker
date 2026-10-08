import type { Metadata } from 'next';
import { requireUser } from '@/lib/auth';
import { SAMPLE_CLASS, guayaquilWeekday, pickSampleClass, titleCase } from '@/lib/class-schedule';
import { getClassReminderMinutes, getClassSchedule } from '@/lib/class-schedule-store';
import { dateToGuayaquilInput } from '@/lib/time';
import ClassReminderSetting from '@/components/ClassReminderSetting';
import RemindersTabs from '@/components/RemindersTabs';
import ScheduleWorkspace from '@/components/ScheduleWorkspace';

export const dynamic = 'force-dynamic';
// Reading an uploaded PDF (previewSchedule) is bounded: past this the platform stops the request instead of
// letting a pathological file hold a function for the default limit.
export const maxDuration = 20;

export const metadata: Metadata = { title: 'Horario de clases' };

/** "2027-01-31" -> "31/01/2027". */
const formatDate = (iso: string): string => iso.split('-').reverse().join('/');

export default async function SchedulePage() {
  const user = await requireUser();
  const [schedule, lead] = await Promise.all([getClassSchedule(user.id), getClassReminderMinutes(user.id)]);
  const now = new Date();
  const classes = schedule?.classes ?? [];
  const sample = pickSampleClass(classes, now);
  const today = dateToGuayaquilInput(now).slice(0, 10);
  const ended = !!schedule?.periodEnd && schedule.periodEnd < today;

  return (
    <>
      <RemindersTabs current="schedule" />

      <section aria-labelledby="schedule-title" className="section">
        <header className="page-head">
          <h1 id="schedule-title">Horario de clases</h1>
          {schedule?.periodLabel && <p className="muted">{titleCase(schedule.periodLabel)}</p>}
        </header>

        {schedule === null && (
          <p className="card muted empty">El horario de clases aún no está disponible. Inténtalo de nuevo más tarde.</p>
        )}

        {schedule && (
          <div className="stack">
            {ended && schedule.periodEnd && classes.length > 0 && (
              <p className="warning" role="status">
                Este horario terminó el {formatDate(schedule.periodEnd)}. Importa el del nuevo período para seguir recibiendo avisos.
              </p>
            )}
            <ScheduleWorkspace saved={classes} today={guayaquilWeekday(now)} />
          </div>
        )}
      </section>

      <section className="card item" id="class-reminder" aria-labelledby="class-reminder-title">
        <h2 id="class-reminder-title" className="card-title">Avisos de clases</h2>
        <ClassReminderSetting
          available={lead.available}
          minutes={lead.minutes}
          sample={sample ?? SAMPLE_CLASS}
          sampleIsReal={!!sample}
        />
      </section>
      <p className="muted small">Horas en Ecuador (UTC-5).</p>
    </>
  );
}
