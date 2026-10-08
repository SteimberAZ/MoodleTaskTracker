import { pageCount } from '@/lib/pagination';
import {
  HISTORY_PAGE_SIZE,
  groupByDay,
  notificationsHref,
  type HistoryFilter,
} from '@/lib/notification-log';
import type { HistoryPage } from '@/lib/notification-history';
import ClearHistoryButton from './ClearHistoryButton';
import HistoryFilters from './HistoryFilters';
import NotificationItem from './NotificationItem';
import Pagination from './Pagination';

interface Props {
  filter: HistoryFilter;
  /** `null` when the history could not be read. */
  result: HistoryPage | null;
  now: Date;
}

/** "Historial de avisos": filter chips, notifications grouped by day, pagination and "Borrar historial". */
export default function NotificationHistory({ filter, result, now }: Props) {
  const groups = result ? groupByDay(result.rows, now) : [];
  const page = result?.page ?? 1;
  const pages = pageCount(result?.total ?? 0, HISTORY_PAGE_SIZE);

  return (
    <section aria-labelledby="historial-title" id="historial" className="section">
      <div className="section-head">
        <h2 id="historial-title">Historial de avisos</h2>
        {result?.available && result.total > 0 && <ClearHistoryButton />}
      </div>

      {!result && <p className="alert" role="alert">No se pudo cargar el historial.</p>}

      {result && !result.available && (
        <p className="card muted empty">El historial estará disponible pronto.</p>
      )}

      {result?.available && (
        <>
          <HistoryFilters active={filter} />
          {result.total === 0 && (
            <p className="card muted empty">
              {filter === 'todos'
                ? 'Aún no hay avisos. Aquí verás cada notificación que te enviemos.'
                : 'No hay avisos de este tipo.'}
            </p>
          )}
          {groups.map((group) => (
            <div key={group.key} className="hist-day">
              <h3 className="hist-day-title">{group.label}</h3>
              <ul className="hist-list">
                {group.items.map((row) => (
                  <NotificationItem key={row.id} row={row} now={now} />
                ))}
              </ul>
            </div>
          ))}
          <Pagination
            page={page}
            pages={pages}
            label="Paginación del historial"
            hrefFor={(p) => notificationsHref({ hk: filter, hp: p }, 'historial')}
          />
        </>
      )}
    </section>
  );
}
