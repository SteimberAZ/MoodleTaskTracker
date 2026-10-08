import Link from 'next/link';
import { homeHref } from '@/lib/pagination';
import LinkPending from './LinkPending';
import { TASK_FILTERS, type TaskFilter } from '@/lib/task-query';

interface Props {
  active: TaskFilter;
  counts: Record<TaskFilter, number> | null;
}

/** Filter chips above the task list (`?tf=`). Switching a tab resets the task page. */
export default function TaskFilters({ active, counts }: Props) {
  return (
    <nav className="chips" aria-label="Filtrar tareas">
      {TASK_FILTERS.map(({ value, label }) => (
        <Link
          key={value}
          href={homeHref({ tf: value }, 'tareas')}
          className="filter-chip"
          aria-current={value === active ? 'true' : undefined}
          scroll={false}
        >
          {label}
          {counts && <span className="filter-count">{counts[value]}</span>}
          <LinkPending />
        </Link>
      ))}
    </nav>
  );
}
