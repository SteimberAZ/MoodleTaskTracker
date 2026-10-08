import Link from 'next/link';

/** Segment at the top of /recordatorios and /horario: the class schedule lives inside Recordatorios. */
export default function RemindersTabs({ current }: { current: 'reminders' | 'schedule' }) {
  return (
    <nav className="segmented-tabs" aria-label="Secciones de recordatorios">
      <Link href="/recordatorios" className="segment" aria-current={current === 'reminders' ? 'page' : undefined}>
        Recordatorios
      </Link>
      <Link href="/horario" className="segment" aria-current={current === 'schedule' ? 'page' : undefined}>
        Horario de clases
      </Link>
    </nav>
  );
}
