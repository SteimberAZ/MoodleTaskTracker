import { pageCount } from '@/lib/pagination';
import {
  HISTORY_PAGE_SIZE,
  groupByDay,
  notificationsHref,
  type HistoryFilter,
} from '@/lib/notification-log';
import type { NotificationLogRow } from '@/lib/notification-log';
import type { HistoryPage } from '@/lib/notification-history';
import ClearHistoryButton from './ClearHistoryButton';
import FocusedNotification from './FocusedNotification';
import HistoryFilters from './HistoryFilters';
import NotificationItem from './NotificationItem';
import Pagination from './Pagination';
import { ListPendingSkeleton } from './Skeletons';

interface Props {
  filter: HistoryFilter;
  /** `null` when the history could not be read. */
  result: HistoryPage | null;
  now: Date;
  /**
   * The notification opened from a tap (`?n=<id>`): `row` is null when it no longer exists, `undefined` when it
   * could not be read (nothing is shown then). Null when the page was not opened from a notification.
   */
  focus?: { id: string; row: NotificationLogRow | null | undefined } | null;
}

/** "Historial de avisos": the opened notification on top, filter chips, entries grouped by day, pagination and "Borrar historial". */
export default function NotificationHistory({ filter, result, now, focus = null }: Props) {
  const groups = result ? groupByDay(result.rows, now) : [];
  const page = result?.page ?? 1;
  const pages = pageCount(result?.total ?? 0, HISTORY_PAGE_SIZE);

  return (
    <section aria-labelledby="historial-title" id="historial" className="section pending-scope">
      <div className="section-head">
        <h2 id="historial-title">Historial de avisos</h2>
        {result?.available && result.total > 0 && <ClearHistoryButton />}
      </div>

      {focus && focus.row !== undefined && <FocusedNotification id={focus.id} row={focus.row} now={now} />}

      {!result && <p className="alert" role="alert">No se pudo cargar el historial.</p>}

      {result && !result.available && (
        <p className="card muted empty">El historial estará disponible pronto.</p>
      )}

      {result?.available && (
        <>
          <HistoryFilters active={filter} />
          <ListPendingSkeleton variant="history" />
          <div className="list-results">
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
                    <NotificationItem key={row.id} row={row} now={now} focused={row.id === focus?.id} />
                  ))}
                </ul>
              </div>
            ))}
          </div>
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
