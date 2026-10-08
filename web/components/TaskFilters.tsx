import Link from 'next/link';
import { homeHref } from '@/lib/pagination';
import { TASK_FILTERS, type TaskFilter } from '@/lib/task-query';

interface Props {
  active: TaskFilter;
  counts: Record<TaskFilter, number> | null;
  /** Reminder page to keep when switching tabs. */
  reminderPage: number;
}

/** Filter chips above the task list (`?tf=`). Switching a tab resets the task page. */
export default function TaskFilters({ active, counts, reminderPage }: Props) {
  return (
    <nav className="chips" aria-label="Filtrar tareas">
      {TASK_FILTERS.map(({ value, label }) => (
        <Link
          key={value}
          href={homeHref({ tf: value, rp: reminderPage }, 'tareas')}
          className="filter-chip"
          aria-current={value === active ? 'true' : undefined}
          scroll={false}
        >
          {label}
          {counts && <span className="filter-count">{counts[value]}</span>}
        </Link>
      ))}
    </nav>
  );
}
