import Link from 'next/link';
import {
  channelBadges,
  kindLabel,
  notificationTargetHref,
  notificationTimeLabel,
  relativeLabel,
  type NotificationLogRow,
} from '@/lib/notification-log';
import ScrollToNotification from './ScrollToNotification';

export const FOCUSED_NOTIFICATION_ID = 'aviso-destacado';

interface Props {
  /** Id taken from `?n=`. */
  id: string;
  /** The entry, or null when it is gone (deleted, pruned or never the session user's). */
  row: NotificationLogRow | null;
  now: Date;
}

/**
 * The notification the user just tapped, highlighted at the top of the history: full text, time, channels
 * and an "Abrir" button to the page it is about. Scrolled into view and focused on load.
 */
export default function FocusedNotification({ id, row, now }: Props) {
  if (!row) {
    return (
      <>
        <p id={FOCUSED_NOTIFICATION_ID} className="card muted empty hist-focus-missing" role="status" tabIndex={-1}>
          Esa notificación ya no está en tu historial.
        </p>
        <ScrollToNotification targetId={FOCUSED_NOTIFICATION_ID} focusKey={id} />
      </>
    );
  }

  const href = notificationTargetHref(row.url);
  const badges = channelBadges(row);
  const relative = relativeLabel(row.created_at, now);
  const parsed = new Date(row.created_at);
  const time = notificationTimeLabel(row.created_at, now);
  const title = row.title || 'Aviso';

  return (
    <>
      <article
        id={FOCUSED_NOTIFICATION_ID}
        className={`card hist-focus${row.status === 'failed' ? ' is-failed' : ''}`}
        tabIndex={-1}
        aria-labelledby={`${FOCUSED_NOTIFICATION_ID}-title`}
      >
        <p className="hist-focus-label">Notificación</p>
        <h3 id={`${FOCUSED_NOTIFICATION_ID}-title`} className="hist-focus-title">{title}</h3>
        {row.body && <p className="hist-focus-body">{row.body}</p>}
        <p className="hist-meta">
          <span>{kindLabel(row.kind)}</span>
          <span aria-hidden="true">·</span>
          {Number.isNaN(parsed.getTime()) ? <span>{time}</span> : <time dateTime={parsed.toISOString()}>{time}</time>}
          {relative && (
            <>
              <span aria-hidden="true">·</span>
              <span>{relative}</span>
            </>
          )}
        </p>
        {badges.length > 0 && (
          <ul className="hist-badges plain-list" aria-label="Entrega">
            {badges.map((b) => (
              <li key={b.key} className={`badge ${b.tone}`}>
                {b.srText ? (
                  <>
                    <span aria-hidden="true">{b.text}</span>
                    <span className="sr-only">{b.srText}</span>
                  </>
                ) : (
                  b.text
                )}
              </li>
            ))}
          </ul>
        )}
        {href && (
          <div className="actions">
            <Link href={href} className="btn primary">Abrir</Link>
          </div>
        )}
      </article>
      <ScrollToNotification targetId={FOCUSED_NOTIFICATION_ID} focusKey={id} />
    </>
  );
}
