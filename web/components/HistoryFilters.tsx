import Link from 'next/link';
import { HISTORY_FILTERS, notificationsHref, type HistoryFilter } from '@/lib/notification-log';

/** Filter chips above the notification history (`?hk=`). Switching a chip resets the history page. */
export default function HistoryFilters({ active }: { active: HistoryFilter }) {
  return (
    <nav className="chips hist-chips" aria-label="Filtrar avisos">
      {HISTORY_FILTERS.map(({ value, label }) => (
        <Link
          key={value}
          href={notificationsHref({ hk: value }, 'historial')}
          className="filter-chip"
          aria-current={value === active ? 'true' : undefined}
          scroll={false}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
